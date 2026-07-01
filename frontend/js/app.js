/**
 * FlowMoney — Точка входа SPA
 * Этап 3: Инициализация Telegram SDK, Theme Engine, SPA-роутер
 */

/* ═══════════════════════════════════════════════════
   0. Блокировка масштабирования (Pinch-to-Zoom & Double-tap Zoom)
   Выполняется немедленно, до любых других инициализаций.
═══════════════════════════════════════════════════ */

// Блокируем pinch-to-zoom: срабатывает при касании двумя и более пальцами
document.addEventListener('touchstart', function (e) {
  if (e.touches.length > 1) {
    e.preventDefault();
  }
}, { passive: false });

// Блокируем gesture-based zoom в Safari/iOS WebKit (gesturestart — проприетарное событие)
document.addEventListener('gesturestart', function (e) {
  e.preventDefault();
}, { passive: false });

// Блокируем double-tap zoom: два касания с интервалом менее 300ms
(function () {
  var lastTapTime = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    if (now - lastTapTime < 300) {
      e.preventDefault();
    }
    lastTapTime = now;
  }, { passive: false });
}());

/* ═══════════════════════════════════════════════════
   1. Telegram WebApp SDK — инициализация
═══════════════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;

function initTelegram() {
  if (!tg) {
    console.warn('[App] Telegram WebApp SDK недоступен — режим браузера');
    return;
  }

  // Сообщаем Telegram, что приложение готово к отображению
  tg.ready();

  // Разворачиваем на полный экран
  tg.expand();

  // Отключаем вертикальный свайп-закрытие на главном экране
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();

  // ── Фиксация высоты body ─────────────────────────────────────────────────
  // На Android системный gesture-bar (нижний "подбородок") может перекрывать
  // контент, потому что dvh и window.innerHeight не учитывают его высоту.
  // tg.viewportStableHeight — высота viewport без учёта экранной клавиатуры;
  // именно это значение мы хотим зафиксировать как высоту body.
  function lockBodyHeight() {
    var h = tg.viewportStableHeight || window.innerHeight;
    document.body.style.height = h + 'px';
    document.getElementById('app').style.height = h + 'px';
  }

  lockBodyHeight();
  tg.onEvent('viewportChanged', lockBodyHeight);

  // ── Безопасный нижний отступ из Telegram SDK ─────────────────────────────
  // env(safe-area-inset-bottom) на Android часто возвращает 0 даже при
  // наличии gesture-bar. Telegram SDK (Bot API 7.x+) предоставляет точное
  // значение через tg.safeAreaInsets.bottom — перезаписываем CSS-переменную.
  var safeBottom = (tg.safeAreaInsets && tg.safeAreaInsets.bottom) || 0;
  if (safeBottom > 0) {
    document.documentElement.style.setProperty('--safe-bottom', safeBottom + 'px');
  }
}

/* ═══════════════════════════════════════════════════
   2. Theme Engine — маппинг Telegram themeParams → CSS vars
      Таблица 4.1 из спецификации
═══════════════════════════════════════════════════ */

function applyTheme(params) {
  const root = document.documentElement;
  const p = params || {};

  // Основные переменные из спеки 4.1
  if (p.bg_color) root.style.setProperty('--bg-color', p.bg_color);
  if (p.secondary_bg_color) root.style.setProperty('--secondary-bg-color', p.secondary_bg_color);
  if (p.text_color) root.style.setProperty('--text-color', p.text_color);
  if (p.hint_color) root.style.setProperty('--hint-color', p.hint_color);
  if (p.button_color) root.style.setProperty('--accent-color', p.button_color);

  // Цвет статус-бара самого Telegram
  if (tg?.setHeaderColor && p.bg_color) {
    tg.setHeaderColor(p.bg_color);
  }
}

function initTheme() {
  if (!tg) return;

  // Первичное применение
  applyTheme(tg.themeParams);

  // Подписка на динамическую смену темы (Light/Dark без перезагрузки)
  tg.onEvent('themeChanged', () => applyTheme(tg.themeParams));
}

/* ═══════════════════════════════════════════════════
   3. SPA-роутер
   Переключение строго через opacity/transform (спека 4.2)
   Никаких display:none — только CSS-классы
═══════════════════════════════════════════════════ */

const Router = (() => {
  const screens = {
    home: document.getElementById('screen-home'),
    analytics: document.getElementById('screen-analytics'),
    settings: document.getElementById('screen-settings'),
  };

  const tabs = document.querySelectorAll('.nav-tab');
  let currentTab = 'home';

  function navigateTo(tabId) {
    if (tabId === currentTab) return;

    const prevTab = currentTab;
    currentTab = tabId;

    // Expose current tab to Store so analytics can react
    Store.state.currentTab = tabId;

    // Haptic Feedback на переключение вкладок (спека 3.1)
    tg?.HapticFeedback?.impactOccurred('light');

    // Скрываем предыдущий экран
    const prevScreen = screens[prevTab];
    if (prevScreen) {
      prevScreen.classList.remove('active');
      prevScreen.setAttribute('aria-hidden', 'true');
    }

    // Показываем новый
    const nextScreen = screens[tabId];
    if (nextScreen) {
      // rAF гарантирует, что браузер успевает применить transition
      requestAnimationFrame(() => {
        nextScreen.classList.add('active');
        nextScreen.removeAttribute('aria-hidden');
      });
    }

    // Обновляем состояние табов
    tabs.forEach(tab => {
      const isActive = tab.dataset.tab === tabId;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });
  }

  function init() {
    Store.state.currentTab = currentTab; // set initial value for subscribers
    tabs.forEach(tab => {
      tab.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        navigateTo(tab.dataset.tab);
      });
    });
  }

  return { init, navigateTo, current: () => currentTab };
})();

/* ═══════════════════════════════════════════════════
   4. Нампад — ввод суммы (спека 3.1)
═══════════════════════════════════════════════════ */

const NumPad = (() => {
  const MAX_DIGITS = 6;   // 999999 — шесть цифр до запятой
  const MAX_DECIMALS = 2;
  const MAX_AMOUNT = 999999;

  function init() {
    const numpad = document.querySelector('.numpad');
    if (!numpad) return;

    // pointerdown для мгновенного отклика, без 300ms delay
    numpad.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('[data-key]');
      if (!key) return;

      e.preventDefault();

      // Скрываем клавиатуру, если фокус был в поле комментария
      const commentInputEl = document.getElementById('tx-comment-input');
      if (commentInputEl && document.activeElement === commentInputEl) {
        commentInputEl.blur();
      }

      // Визуальная обратная связь
      key.classList.add('pressed');
      setTimeout(() => key.classList.remove('pressed'), 120);

      // Haptic на каждое нажатие клавиши (спека 3.1)
      tg?.HapticFeedback?.impactOccurred('light');

      handleKey(key.dataset.key);
    });
  }

  function handleKey(key) {
    let current = Store.state.inputAmount;

    if (key === 'backspace') {
      Store.state.inputAmount = current.slice(0, -1);
      return;
    }

    if (key === '.') {
      if (current.includes('.')) return;
      Store.state.inputAmount = current === '' ? '0.' : current + '.';
      return;
    }

    // Цифра
    const parts = current.split('.');
    if (parts[0].length >= MAX_DIGITS && !current.includes('.')) return;
    if (parts[1] !== undefined && parts[1].length >= MAX_DECIMALS) return;

    // Убираем ведущий ноль, затем проверяем лимит 999999
    const newValue = current === '0' ? key : current + key;
    if (parseFloat(newValue) > MAX_AMOUNT) return;
    Store.state.inputAmount = newValue;
  }

  return { init };
})();

/* ═══════════════════════════════════════════════════
   5. Шторка создания категории
═══════════════════════════════════════════════════ */

const CategoryCreationSheet = (() => {
  const EMOJIS = [
    // Finance
    '💰', '💳', '🏦',
    // Transport
    '🚇', '🚗', '✈️', '🛵', '🚌', '⛽', '🚕', '🚬',
    // Leisure
    '🎮', '🎬', '⚽', '🎸', '📚',
    // Health
    '💊', '🏋️', '🍎',
    // Utilities & Home
    '🏠', '💡', '🛒', '☕',
    // Food & Shopping
    '🍺', '🛍️', '💅', '📦', '🍜', '🐶', '🍽️',
    // Other
    '➕', '📱',
  ];
  const COLORS = [
    '#FF6B6B', '#FF8E53', '#FFD93D', '#6BCB77',
    '#4ECDC4', '#45B7D1', '#4D96FF', '#A29BFE',
    '#C77DFF', '#FF6EB4', '#98D8C8', '#B5BAD0',
    '#FFB3BA', '#FFDFBA', '#FFFFBA', '#BAFFC9',
    '#BAE1FF', '#E0BBE4', '#D4F1F4', '#FFC8DD',
  ];

  let _emoji = EMOJIS[0];
  let _color = COLORS[0];
  let _editMode = false;
  let _editingCategory = null;

  const sheet = document.getElementById('category-creation-sheet');

  function _updatePreview() {
    const icon = document.getElementById('cat-sheet-preview-icon');
    if (!icon) return;
    icon.textContent = _emoji;
    icon.style.background = _color + '22';
    icon.style.borderColor = _color;
  }

  function _syncEmojiGrid() {
    const grid = document.getElementById('cat-emoji-grid');
    if (!grid) return;
    grid.querySelectorAll('.cat-emoji-option').forEach(el => {
      const sel = el.dataset.emoji === _emoji;
      el.classList.toggle('selected', sel);
      el.setAttribute('aria-selected', String(sel));
    });
  }

  function _getUsedColors() {
    const editingId = _editMode && _editingCategory ? String(_editingCategory.id) : null;
    const used = new Set();
    (Store.state.categories || []).forEach(cat => {
      if (cat.is_deleted) return;
      if (editingId !== null && String(cat.id) === editingId) return;
      used.add(cat.color);
    });
    return used;
  }

  function _renderColorPalette() {
    const palette = document.getElementById('cat-color-palette');
    if (!palette) return;
    const usedColors = _getUsedColors();
    palette.textContent = '';
    const frag = document.createDocumentFragment();
    COLORS.forEach(color => {
      const isDisabled = usedColors.has(color) && color !== _color;
      const el = document.createElement('div');
      el.className = 'cat-color-swatch' + (color === _color ? ' selected' : '') + (isDisabled ? ' disabled' : '');
      el.dataset.color = color;
      el.style.background = color;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-label', color);
      el.setAttribute('aria-selected', String(color === _color));
      if (isDisabled) el.setAttribute('aria-disabled', 'true');
      frag.appendChild(el);
    });
    palette.appendChild(frag);
  }

  function open(categoryObj) {
    _editMode = !!categoryObj;
    _editingCategory = categoryObj || null;
    _emoji = categoryObj ? categoryObj.icon : EMOJIS[0];
    _color = categoryObj ? categoryObj.color : COLORS[0];

    const nameInput = document.getElementById('cat-sheet-name');
    if (nameInput) nameInput.value = categoryObj ? categoryObj.name : '';

    const titleEl = sheet.querySelector('.cat-sheet-title');
    if (titleEl) titleEl.textContent = _editMode ? 'Редактировать' : 'Новая категория';

    const confirmBtn = document.getElementById('cat-sheet-confirm');
    if (confirmBtn) confirmBtn.textContent = _editMode ? 'Сохранить' : 'Добавить';

    const deleteBtn = document.getElementById('category-delete-btn');
    if (deleteBtn) deleteBtn.style.display = _editMode ? 'block' : 'none';

    const reorderBtn = document.getElementById('category-reorder-btn');
    if (reorderBtn) reorderBtn.style.display = _editMode ? 'block' : 'none';

    _updatePreview();
    _syncEmojiGrid();
    _renderColorPalette();
    requestAnimationFrame(() => {
      sheet.classList.add('active');
      sheet.removeAttribute('aria-hidden');
    });
  }

  function close() {
    _editMode = false;
    _editingCategory = null;
    sheet.classList.remove('active');
    setTimeout(() => sheet.setAttribute('aria-hidden', 'true'), 340);
  }

  function _confirm() {
    const nameInput = document.getElementById('cat-sheet-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      tg?.HapticFeedback?.notificationOccurred?.('error');
      if (nameInput) {
        nameInput.classList.add('error');
        setTimeout(() => nameInput.classList.remove('error'), 400);
      }
      return;
    }

    if (_editMode && _editingCategory) {
      const updated = { ..._editingCategory, name, icon: _emoji, color: _color };
      tg?.HapticFeedback?.impactOccurred('medium');
      StorageManager.updateUserCategory(updated);
      SyncRunner.syncWithBackend();
      close();
      return;
    }

    const cat = {
      id: self.crypto.randomUUID(),
      user_id: null,
      name,
      icon: _emoji,
      color: _color,
      is_system: false,
    };

    tg?.HapticFeedback?.impactOccurred('medium');
    StorageManager.saveUserCategory(cat);
    SyncRunner.syncWithBackend();
    close();
  }

  function _delete() {
    if (!_editingCategory) return;
    tg?.HapticFeedback?.notificationOccurred?.('warning');
    StorageManager.updateUserCategory({ ..._editingCategory, is_deleted: true });
    SyncRunner.syncWithBackend();
    close();
  }

  function init() {
    if (!sheet) return;

    const backdrop = sheet.querySelector('.bottom-sheet-backdrop');
    if (backdrop) backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });

    const closeBtn = document.getElementById('cat-sheet-close');
    if (closeBtn) closeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });

    const confirmBtn = document.getElementById('cat-sheet-confirm');
    if (confirmBtn) confirmBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); _confirm(); });

    const deleteBtn = document.getElementById('category-delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); _delete(); });

    const reorderBtn = document.getElementById('category-reorder-btn');
    if (reorderBtn) reorderBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      close();
      Store.state.isReorderingMode = true;
    });

    // Build emoji grid via createElement (XSS-safe; values are hardcoded)
    const grid = document.getElementById('cat-emoji-grid');
    if (grid) {
      const frag = document.createDocumentFragment();
      EMOJIS.forEach(emoji => {
        const el = document.createElement('div');
        el.className = 'cat-emoji-option' + (emoji === _emoji ? ' selected' : '');
        el.dataset.emoji = emoji;
        el.textContent = emoji;
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', String(emoji === _emoji));
        frag.appendChild(el);
      });
      grid.appendChild(frag);

      // passive: true — this listener sits inside .cat-sheet-scroll; calling
      // preventDefault() on pointerdown here (as before) cancels WebKit's touch
      // default action the same way touchstart would, killing native scroll
      // whenever a drag starts on top of a grid cell.
      grid.addEventListener('pointerdown', (e) => {
        const opt = e.target.closest('.cat-emoji-option');
        if (!opt) return;
        tg?.HapticFeedback?.impactOccurred('light');
        _emoji = opt.dataset.emoji;
        _updatePreview();
        _syncEmojiGrid();
      }, { passive: true });
    }

    // Build color palette via createElement (XSS-safe; values are hardcoded)
    const palette = document.getElementById('cat-color-palette');
    if (palette) {
      _renderColorPalette();

      // Same passive fix as the emoji grid above — this also lives inside
      // .cat-sheet-scroll and must not cancel the native scroll gesture.
      palette.addEventListener('pointerdown', (e) => {
        const swatch = e.target.closest('.cat-color-swatch');
        if (!swatch || swatch.classList.contains('disabled')) return;
        tg?.HapticFeedback?.impactOccurred('light');
        _color = swatch.dataset.color;
        _updatePreview();
        _renderColorPalette();
      }, { passive: true });
    }
  }

  return { init, open, close };
})();

/* ═══════════════════════════════════════════════════
   5а. Карусель категорий — рендер и выбор
═══════════════════════════════════════════════════ */

const CategoryCarousel = (() => {

  function render(categories) {
    const carousel = document.getElementById('category-carousel');
    if (!carousel) return;

    // Preserve selected category across re-renders
    const prevSelectedId = Store.state.selectedCategory;
    // Archived categories (is_deleted) stay in the store for history resolution
    // but must never appear in the creation carousel.
    const activeCategories = categories
      .filter(c => !c.is_deleted)
      .sort((a, b) => a.sort_order - b.sort_order);

    // If previously selected category was deleted, clear the selection
    if (prevSelectedId && !activeCategories.some(cat => cat.id === prevSelectedId)) {
      Store.state.selectedCategory = null;
    }

    carousel.textContent = '';

    const fragment = document.createDocumentFragment();
    activeCategories.forEach(cat => {
      const item = document.createElement('div');
      item.className = 'category-item';
      item.setAttribute('role', 'option');
      item.dataset.id = cat.id;

      const isSelected = cat.id === prevSelectedId;
      item.setAttribute('aria-selected', String(isSelected));
      if (isSelected) item.classList.add('selected');

      const iconEl = document.createElement('div');
      iconEl.className = 'category-icon';
      iconEl.style.background = cat.color + '22';
      iconEl.style.boxShadow = isSelected ? `0 0 0 2px ${cat.color}` : 'none';
      iconEl.textContent = cat.icon;

      const nameEl = document.createElement('span');
      nameEl.className = 'category-name';
      nameEl.textContent = cat.name;

      item.appendChild(iconEl);
      item.appendChild(nameEl);
      fragment.appendChild(item);
    });

    // Trailing "+" button — triggers CategoryCreationSheet
    const addBtn = document.createElement('div');
    addBtn.className = 'category-add-btn';
    addBtn.setAttribute('role', 'button');
    addBtn.setAttribute('aria-label', 'Добавить категорию');

    const addIcon = document.createElement('div');
    addIcon.className = 'category-add-icon';
    addIcon.textContent = '+';

    const addLabel = document.createElement('span');
    addLabel.className = 'category-add-label';
    addLabel.textContent = 'Ещё';

    addBtn.appendChild(addIcon);
    addBtn.appendChild(addLabel);
    if (Store.state.isReorderingMode) addBtn.style.display = 'none';
    fragment.appendChild(addBtn);

    carousel.appendChild(fragment);
  }

  function _setReorderingMode(active) {
    const carousel = document.getElementById('category-carousel');
    const doneBtn = document.getElementById('category-reorder-done-btn');
    if (carousel) carousel.classList.toggle('reordering-mode', active);
    const addBtn = carousel ? carousel.querySelector('.category-add-btn') : null;
    if (addBtn) addBtn.style.display = active ? 'none' : '';
    if (doneBtn) doneBtn.style.display = active ? 'block' : 'none';
  }

  function init() {
    // Defer initial render until after bootstrap() completes to avoid rendering stale cached data.
    // The Store subscriber (below) will handle rendering when categories are updated from the server.

    // Single delegated listener — covers both category items and the "+" button.
    // Added once in init() so re-renders (render()) never stack up listeners.
    const carousel = document.getElementById('category-carousel');
    if (carousel) {
      let _longPressTimer = null;
      let _startX = 0;
      let _startY = 0;
      let _longPressFired = false;
      const MOVE_THRESHOLD = 10;
      const LONG_PRESS_MS = 500;

      const _cancelLongPress = () => {
        clearTimeout(_longPressTimer);
        _longPressTimer = null;
      };

      const _onPressStart = (item, x, y) => {
        tg?.HapticFeedback?.impactOccurred('light');

        carousel.querySelectorAll('.category-item.selected').forEach(el => {
          el.classList.remove('selected');
          el.setAttribute('aria-selected', 'false');
          const prevIcon = el.querySelector('.category-icon');
          if (prevIcon) prevIcon.style.boxShadow = 'none';
        });

        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        const cat = (Store.state.categories || []).find(c => String(c.id) === item.dataset.id);
        const icon = item.querySelector('.category-icon');
        if (icon && cat) icon.style.boxShadow = `0 0 0 2px ${cat.color}`;
        Store.state.selectedCategory = item.dataset.id;

        _startX = x;
        _startY = y;
        _longPressFired = false;

        _cancelLongPress();
        _longPressTimer = setTimeout(() => {
          _longPressTimer = null;
          _longPressFired = true;
          tg?.HapticFeedback?.notificationOccurred?.('warning');
          const cat = (Store.state.categories || []).find(c => String(c.id) === item.dataset.id);
          if (cat) CategoryCreationSheet.open(cat);
        }, LONG_PRESS_MS);
      };

      const _onPressMove = (x, y) => {
        if (!_longPressTimer) return;
        if (Math.abs(x - _startX) > MOVE_THRESHOLD || Math.abs(y - _startY) > MOVE_THRESHOLD) {
          _cancelLongPress();
        }
      };

      const _supportsTouch = 'ontouchstart' in window;

      if (_supportsTouch) {
        carousel.addEventListener('touchstart', (e) => {
          if (Store.state.isReorderingMode) return;
          if (e.target.closest('#category-reorder-done-btn')) return;
          if (e.target.closest('.category-add-btn')) {
            tg?.HapticFeedback?.impactOccurred('light');
            CategoryCreationSheet.open();
            return;
          }

          const item = e.target.closest('.category-item');
          if (!item) return;

          const touch = e.touches[0];
          _onPressStart(item, touch.clientX, touch.clientY);
        }, { passive: true });

        carousel.addEventListener('touchmove', (e) => {
          const touch = e.touches[0];
          if (!touch) return;
          _onPressMove(touch.clientX, touch.clientY);
        }, { passive: true });

        carousel.addEventListener('touchend', (e) => {
          if (_longPressFired) {
            e.preventDefault();
            e.stopPropagation();
          }
          _cancelLongPress();
        });

        carousel.addEventListener('touchcancel', _cancelLongPress);
      } else {
        carousel.addEventListener('pointerdown', (e) => {
          if (Store.state.isReorderingMode) return;
          if (e.target.closest('#category-reorder-done-btn')) return;
          if (e.target.closest('.category-add-btn')) {
            e.preventDefault();
            tg?.HapticFeedback?.impactOccurred('light');
            CategoryCreationSheet.open();
            return;
          }

          const item = e.target.closest('.category-item');
          if (!item) return;

          _onPressStart(item, e.clientX, e.clientY);
        });

        carousel.addEventListener('pointermove', (e) => _onPressMove(e.clientX, e.clientY));

        carousel.addEventListener('pointerup', (e) => {
          if (_longPressFired) {
            e.preventDefault();
            e.stopPropagation();
          }
          _cancelLongPress();
        });

        carousel.addEventListener('pointercancel', _cancelLongPress);
      }

      // ── Режим сортировки: перетаскивание .category-item через Pointer Events ──
      // Работает единообразно для touch/mouse/pen и активно только при isReorderingMode.
      let _drag = null; // { item, pointerId, startX }

      const _endDrag = () => {
        if (!_drag) return;
        try { _drag.item.releasePointerCapture(_drag.pointerId); } catch (e) { /* уже отпущен */ }
        _drag.item.classList.remove('dragging');
        _drag.item.style.transform = '';
        _drag.item.style.zIndex = '';
        carousel.removeEventListener('pointermove', _onDragMove);
        carousel.removeEventListener('pointerup', _onDragEnd);
        carousel.removeEventListener('pointercancel', _onDragEnd);
        _drag = null;
      };

      function _onDragMove(e) {
        if (!_drag || e.pointerId !== _drag.pointerId) return;
        e.preventDefault();

        const dx = e.clientX - _drag.startX;
        _drag.item.style.transform = `translateX(${dx}px)`;

        const draggedRect = _drag.item.getBoundingClientRect();
        const draggedCenter = draggedRect.left + draggedRect.width / 2;

        const prev = _drag.item.previousElementSibling;
        if (prev && prev.classList.contains('category-item')) {
          const prevRect = prev.getBoundingClientRect();
          if (draggedCenter < prevRect.left + prevRect.width / 2) {
            carousel.insertBefore(_drag.item, prev);
            _drag.startX = e.clientX;
            _drag.item.style.transform = 'translateX(0px)';
            return;
          }
        }

        const next = _drag.item.nextElementSibling;
        if (next && next.classList.contains('category-item')) {
          const nextRect = next.getBoundingClientRect();
          if (draggedCenter > nextRect.left + nextRect.width / 2) {
            carousel.insertBefore(next, _drag.item);
            _drag.startX = e.clientX;
            _drag.item.style.transform = 'translateX(0px)';
          }
        }
      }

      function _onDragEnd(e) {
        if (!_drag || e.pointerId !== _drag.pointerId) return;
        _endDrag();
      }

      carousel.addEventListener('pointerdown', (e) => {
        if (!Store.state.isReorderingMode) return;
        // "Готово" живёт вне карусели, но проверяем явно — на случай если
        // разметка изменится и кнопка окажется внутри делегирующего контейнера.
        if (e.target.closest('#category-reorder-done-btn')) return;
        const item = e.target.closest('.category-item');
        if (!item) return;
        e.preventDefault();

        tg?.HapticFeedback?.impactOccurred('medium');

        _drag = { item, pointerId: e.pointerId, startX: e.clientX };
        item.setPointerCapture(e.pointerId);
        item.classList.add('dragging');

        carousel.addEventListener('pointermove', _onDragMove);
        carousel.addEventListener('pointerup', _onDragEnd);
        carousel.addEventListener('pointercancel', _onDragEnd);
      });
    }

    // Re-render whenever categories change, including an empty array (all deleted).
    // Array.isArray guards against the null/undefined default before StorageManager.init() runs.
    Store.subscribe('categories', (cats) => {
      if (Array.isArray(cats)) render(cats);
    });

    Store.subscribe('isReorderingMode', (active) => _setReorderingMode(active));

    const doneBtn = document.getElementById('category-reorder-done-btn');
    if (doneBtn) doneBtn.addEventListener('pointerdown', (e) => {
      // stopPropagation гарантирует, что тап не будет перехвачен слоем
      // делегированных pointerdown-слушателей карусели (drag/selection).
      e.stopPropagation();
      e.preventDefault();
      tg?.HapticFeedback?.impactOccurred('light');

      const items = document.querySelectorAll('#category-carousel .category-item');
      const orderedIds = [];
      for (const item of items) {
        const id = item.dataset.id;
        if (!id) continue; // Пропускаем служебные элементы без ID (напр. "Ещё")
        orderedIds.push(id);
      }

      StorageManager.reorderCategories(orderedIds);
      SyncRunner.syncWithBackend();

      Store.state.isReorderingMode = false;
    });
  }

  return { init, render };
})();

/* ═══════════════════════════════════════════════════
   6а. BudgetCard — переключатель Неделя / Месяц
═══════════════════════════════════════════════════ */

const BudgetCard = (() => {
  let _period = 'week'; // 'week' | 'month'

  function _computeAvailable(period) {
    const limit = period === 'week'
      ? (Store.state.weeklyLimit || 0)
      : (Store.state.monthlyLimit || 0);
    if (!limit) return null;

    const txs = Store.state.transactions || [];
    const now = new Date();
    const rates = Store.state.rates || {};
    const appCur = (Store.state.currency || 'RUB').toUpperCase();

    let start;
    if (period === 'week') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }

    const spent = txs
      .filter(tx => !tx.is_deleted && new Date(tx.created_at) >= start)
      .reduce((sum, tx) => {
        const txCur = (tx.currency || appCur).toUpperCase();
        let amt = parseFloat(tx.amount) || 0;
        if (txCur !== appCur && rates[txCur] && rates[appCur]) {
          amt = (amt / rates[txCur]) * rates[appCur];
        }
        return sum + amt;
      }, 0);

    return limit - spent;
  }

  function _render() {
    const el = document.getElementById('budget-available');
    if (!el) return;

    const limit = _period === 'week'
      ? (Store.state.weeklyLimit || 0)
      : (Store.state.monthlyLimit || 0);
    const val = _computeAvailable(_period);

    if (val === null) {
      el.textContent = '—';
      el.className = 'budget-amount';
      return;
    }

    el.textContent = formatCurrency(val, Store.state.currency);
    el.className = 'budget-amount';
    if (limit > 0) {
      const ratio = val / limit;
      if (ratio <= 0) el.classList.add('danger');
      else if (ratio < 0.3) el.classList.add('warning');
    }
  }

  function init() {
    const toggle = document.getElementById('budget-period-toggle');
    if (toggle) {
      toggle.addEventListener('pointerdown', (e) => {
        const opt = e.target.closest('[data-period]');
        if (!opt || opt.dataset.period === _period) return;
        e.preventDefault();

        _period = opt.dataset.period;
        toggle.querySelectorAll('[data-period]').forEach(el => {
          el.classList.toggle('active', el.dataset.period === _period);
        });

        tg?.HapticFeedback?.selectionChanged?.();
        _render();
      });
    }

    Store.subscribe('weeklyLimit', _render);
    Store.subscribe('monthlyLimit', _render);
    Store.subscribe('transactions', _render);
    Store.subscribe('currency', _render);
    Store.subscribe('rates', _render);
  }

  return { init };
})();

/* ═══════════════════════════════════════════════════
   6. Реактивные биндинги DOM ← Store
═══════════════════════════════════════════════════ */

function initBindings() {
  const amountDisplay = document.getElementById('amount-display');
  const btnAdd = document.getElementById('btn-add');
  const currencySymbol = document.getElementById('currency-symbol');

  // Дисплей суммы
  Store.subscribe('inputAmount', (val) => {
    if (!amountDisplay) return;
    amountDisplay.textContent = val === '' ? '0' : val;
    updateAddButton();
  });

  // Выбор категории влияет на кнопку
  Store.subscribe('selectedCategory', () => updateAddButton());

  // Символ валюты + обновление текстовых меток пончика (без перерисовки SVG-сегментов)
  Store.subscribe('currency', (val) => {
    if (currencySymbol) currencySymbol.textContent = getCurrencySymbol(val);
    if (Store.state.currentTab === 'analytics') {
      // Пересчитываем суммы в новой валюте через rates, затем обновляем только текст.
      const freshData = computeLocalDonutData();
      DonutChart.refreshCurrencyLabels(val, freshData);
    }
  });

  function updateAddButton() {
    if (!btnAdd) return;
    const amount = parseFloat(Store.state.inputAmount);
    const cat = Store.state.selectedCategory;
    btnAdd.disabled = !(cat && amount > 0);
  }

  // Кнопка "Добавить"
  if (btnAdd) {
    btnAdd.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (btnAdd.disabled) return;

      tg?.HapticFeedback?.impactOccurred('medium');
      handleAddTransaction();
    });
  }

  // Скрываем нативную клавиатуру по Enter
  const commentInputEl = document.getElementById('tx-comment-input');
  if (commentInputEl) {
    commentInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.keyCode === 13) commentInputEl.blur();
    });
  }
}

/* ═══════════════════════════════════════════════════
   7. Транзакции — добавление
═══════════════════════════════════════════════════ */

function handleAddTransaction() {
  const amount = parseFloat(Store.state.inputAmount);
  const catId = Store.state.selectedCategory;
  if (!amount || !catId) return;

  const commentInput = document.getElementById('tx-comment-input');
  const comment = commentInput ? commentInput.value.trim() : '';

  // Сохраняем локально — StorageManager сам обновит Store (оптимистичный апдейт)
  const tx = StorageManager.saveTransactionLocally({
    category_id: catId,
    amount,
    created_at: new Date().toISOString(),
    comment: comment || undefined,
  });

  // Сбрасываем ввод
  Store.state.inputAmount = '';
  Store.state.selectedCategory = null;
  if (commentInput) commentInput.value = '';

  // Сбрасываем выделение категории в DOM
  document.querySelectorAll('.category-item.selected').forEach(el => {
    el.classList.remove('selected');
    el.setAttribute('aria-selected', 'false');
    const icon = el.querySelector('.category-icon');
    if (icon) icon.style.boxShadow = 'none';
  });

  console.info('[App] Transaction saved locally:', tx.id);

  // Внеочередная попытка синхронизации (не блокирует UI)
  SyncRunner.syncWithBackend();
}

/* ═══════════════════════════════════════════════════
   8. Аналитика — загрузка и рендер
═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
   8а. Период аналитики — вычисление диапазона дат
═══════════════════════════════════════════════════ */

function updateAnalyticsRange() {
  const period = Store.state.analyticsPeriod;
  if (period === 'custom') return;
  const now = new Date();
  let start, end;

  if (period === 'day') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else {
    // 'month' и fallback
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    // day=0 следующего месяца → последний день текущего
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  Store.state.analyticsRange = { start: start.getTime(), end: end.getTime() };
}

function computeLocalDonutData() {
  const transactions = Store.state.transactions || [];
  const { start, end } = Store.state.analyticsRange;

  const filteredTxs = transactions.filter(tx => {
    if (tx.is_deleted) return false;
    if (start === null || end === null) return false;
    const txTime = new Date(tx.created_at).getTime();
    return txTime >= start && txTime <= end;
  });

  const appCur = (Store.state.currency || 'RUB').toUpperCase();
  const rates = Store.state.rates || {};

  const groups = {};
  filteredTxs.forEach(tx => {
    const txCurrency = (tx.currency || appCur).toUpperCase();
    let amountInAppCurrency = parseFloat(tx.amount) || 0;

    if (txCurrency !== appCur && rates[txCurrency] && rates[appCur]) {
      amountInAppCurrency = (amountInAppCurrency / rates[txCurrency]) * rates[appCur];
    }

    groups[tx.category_id] = (groups[tx.category_id] || 0) + amountInAppCurrency;
  });

  return Object.keys(groups).map(catId => ({
    category_id: catId,
    total: Number(groups[catId].toFixed(2)),
  }));
}

function loadAnalyticsData() {
  const cats = Store.state.categories;
  const catMap = {};
  cats.forEach(c => { catMap[c.id] = c; });

  const localDonut = computeLocalDonutData();
  const enriched = localDonut.map(item => ({
    ...item,
    name: catMap[item.category_id]?.name || item.category_id,
    color: catMap[item.category_id]?.color || '#888888',
    icon: catMap[item.category_id]?.icon || '💰',
  }));

  Store.state.analyticsDonut = enriched;
  DonutChart.renderDonutChart('donut-container', enriched);
  renderTimelineFromStore();
}

function renderTimelineFromStore() {
  const filterCat = Store.state.selectedAnalyticsCategory;
  let txs = Store.state.transactions || [];
  if (filterCat) txs = txs.filter(tx => tx.category_id === filterCat);
  DonutChart.renderTimeline('timeline', txs, Store.state.categories);
}

/* ═══════════════════════════════════════════════════
   8б. CalendarSheet — кастомная шторка-календарь
═══════════════════════════════════════════════════ */

const CalendarSheet = (() => {
  const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const WEEKDAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  let currentTarget = null;  // 'start' | 'end'
  let viewYear = 0;
  let viewMonth = 0;

  const sheet = document.getElementById('calendar-sheet');
  const grid = document.getElementById('calendar-grid');
  const monthLabel = document.getElementById('calendar-month-label');
  const startLabel = document.getElementById('calendar-start-label');
  const endLabel = document.getElementById('calendar-end-label');

  function fmtLabel(ts) {
    const d = new Date(ts);
    return String(d.getDate()).padStart(2, '0') + '.' +
      String(d.getMonth() + 1).padStart(2, '0') + '.' +
      d.getFullYear();
  }

  function syncLabels() {
    const range = Store.state.analyticsRange;
    if (!range) return;
    if (startLabel && range.start) startLabel.textContent = fmtLabel(range.start);
    if (endLabel && range.end) endLabel.textContent = fmtLabel(range.end);
  }

  function open(target) {
    currentTarget = target;
    const range = Store.state.analyticsRange || {};
    const refTs = target === 'start' ? range.start : range.end;
    const ref = refTs ? new Date(refTs) : new Date();
    viewYear = ref.getFullYear();
    viewMonth = ref.getMonth();
    renderGrid();
    sheet.classList.add('active');
    sheet.removeAttribute('aria-hidden');
  }

  function close() {
    sheet.classList.remove('active');
    sheet.setAttribute('aria-hidden', 'true');
  }

  function renderGrid() {
    monthLabel.textContent = MONTHS_RU[viewMonth] + ' ' + viewYear;
    grid.textContent = '';

    const today = new Date();
    const todayNorm = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const range = Store.state.analyticsRange || {};

    function normDay(ts) {
      const d = new Date(ts);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    const rsNorm = range.start ? normDay(range.start) : null;
    const reNorm = range.end ? normDay(range.end) : null;

    const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
    const startOffset = (firstDow + 6) % 7;                       // Mon=0
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < startOffset; i++) {
      const empty = document.createElement('div');
      empty.className = 'calendar-day empty';
      fragment.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const btn = document.createElement('div');
      btn.className = 'calendar-day';
      btn.dataset.day = day;
      btn.appendChild(document.createTextNode(String(day)));

      const dayNorm = new Date(viewYear, viewMonth, day).getTime();

      if (dayNorm === todayNorm) btn.classList.add('today');

      if (rsNorm !== null && reNorm !== null) {
        if (dayNorm === rsNorm) btn.classList.add('range-start');
        else if (dayNorm === reNorm) btn.classList.add('range-end');
        else if (dayNorm > rsNorm && dayNorm < reNorm) btn.classList.add('in-range');
      } else if (rsNorm !== null && dayNorm === rsNorm) {
        btn.classList.add('range-start');
      } else if (reNorm !== null && dayNorm === reNorm) {
        btn.classList.add('range-end');
      }

      fragment.appendChild(btn);
    }

    grid.appendChild(fragment);
  }

  function handleDayTap(day) {
    const dayStart = new Date(viewYear, viewMonth, day).getTime();
    const dayEnd = new Date(viewYear, viewMonth, day, 23, 59, 59, 999).getTime();
    const labelText = String(day).padStart(2, '0') + '.' +
      String(viewMonth + 1).padStart(2, '0') + '.' + viewYear;
    const prev = Store.state.analyticsRange || {};
    let newStart = prev.start ?? dayStart;
    let newEnd = prev.end ?? dayEnd;

    if (currentTarget === 'start') {
      newStart = dayStart;
      if (startLabel) startLabel.textContent = labelText;
      if (newStart > newEnd) {
        newEnd = dayEnd;
        if (endLabel) endLabel.textContent = labelText;
      }
    } else {
      newEnd = dayEnd;
      if (endLabel) endLabel.textContent = labelText;
      if (newEnd < newStart) {
        newStart = dayStart;
        if (startLabel) startLabel.textContent = labelText;
      }
    }

    Store.state.analyticsRange = { start: newStart, end: newEnd };
    Store.state.analyticsPeriod = 'custom';
    if (Store.state.currentTab === 'analytics') loadAnalyticsData();
    close();
  }

  function init() {
    if (!sheet) return;

    // Render static weekday headers once
    const weekdaysEl = sheet.querySelector('.calendar-weekdays');
    if (weekdaysEl) {
      WEEKDAYS_RU.forEach(name => {
        const el = document.createElement('div');
        el.className = 'calendar-weekday';
        el.textContent = name;
        weekdaysEl.appendChild(el);
      });
    }

    // Backdrop closes sheet
    const backdrop = sheet.querySelector('.bottom-sheet-backdrop');
    if (backdrop) backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });

    // Month navigation
    const prevBtn = document.getElementById('calendar-prev');
    const nextBtn = document.getElementById('calendar-next');
    if (prevBtn) prevBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tg?.HapticFeedback?.impactOccurred('light');
      if (--viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderGrid();
    });
    if (nextBtn) nextBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tg?.HapticFeedback?.impactOccurred('light');
      if (++viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderGrid();
    });

    // Day taps — delegated
    if (grid) grid.addEventListener('pointerdown', (e) => {
      const day = e.target.closest('.calendar-day:not(.empty)');
      if (!day) return;
      e.preventDefault();
      tg?.HapticFeedback?.impactOccurred('light');
      handleDayTap(parseInt(day.dataset.day, 10));
    });

    // Trigger buttons
    const startTrigger = document.getElementById('calendar-start-trigger');
    const endTrigger = document.getElementById('calendar-end-trigger');
    if (startTrigger) startTrigger.addEventListener('pointerdown', (e) => { e.preventDefault(); open('start'); });
    if (endTrigger) endTrigger.addEventListener('pointerdown', (e) => { e.preventDefault(); open('end'); });
  }

  return { init, open, close, syncLabels };
})();

function initPeriodSwitcher() {
  const switcher = document.querySelector('.analytics-period-switcher');
  const datePicker = document.getElementById('custom-date-picker');
  if (!switcher) return;

  switcher.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    e.preventDefault();

    const period = btn.dataset.period;
    if (period === Store.state.analyticsPeriod) return;

    tg?.HapticFeedback?.impactOccurred('light');

    switcher.querySelectorAll('[data-period]').forEach(b => {
      b.classList.toggle('active', b.dataset.period === period);
      b.setAttribute('aria-pressed', String(b.dataset.period === period));
    });

    if (period === 'custom') {
      const now = new Date();
      if (!Store.state.analyticsRange?.start) {
        Store.state.analyticsRange = {
          start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
          end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime(),
        };
      }
      CalendarSheet.syncLabels();
      if (datePicker) { datePicker.style.display = 'flex'; datePicker.removeAttribute('aria-hidden'); }
      Store.state.analyticsPeriod = 'custom';
      if (Store.state.currentTab === 'analytics') loadAnalyticsData();
    } else {
      if (datePicker) { datePicker.style.display = 'none'; datePicker.setAttribute('aria-hidden', 'true'); }
      Store.state.analyticsPeriod = period;
      updateAnalyticsRange();
      if (Store.state.currentTab === 'analytics') loadAnalyticsData();
    }
  });
}

function initAnalytics() {
  // Load analytics data whenever the analytics tab is opened.
  // Paint cached data immediately so the chart isn't blank during the async fetch.
  Store.subscribe('currentTab', (tab) => {
    if (tab !== 'analytics') return;
    const cached = Store.state.analyticsDonut;
    if (cached && cached.length > 0) {
      DonutChart.renderDonutChart('donut-container', cached);
    }
    loadAnalyticsData();
  });

  // Re-render timeline when category filter changes (tap on donut segment)
  Store.subscribe('selectedAnalyticsCategory', () => {
    if (Store.state.currentTab === 'analytics') renderTimelineFromStore();
  });

  // Refresh donut + timeline when local transactions change (add / delete / sync)
  Store.subscribe('transactions', () => {
    if (Store.state.currentTab === 'analytics') loadAnalyticsData();
  });

  initPeriodSwitcher();
  CalendarSheet.init();

  // Wire up swipe gestures once on the persistent container
  const timelineEl = document.getElementById('timeline');
  SwipeGesture.init(timelineEl, {
    onDelete(txId) {
      StorageManager.deleteLocally(txId);
      SyncRunner.syncWithBackend();
    },
    onDuplicate(txId) {
      const tx = (Store.state.transactions || []).find(t => t.id === txId);
      if (!tx) return;

      const txCurrency = tx.currency || Store.state.currency;
      let targetAmount = tx.amount;
      if (txCurrency !== Store.state.currency && Store.state.rates[txCurrency]) {
        targetAmount = (tx.amount / Store.state.rates[txCurrency]) * Store.state.rates[Store.state.currency];
      }

      StorageManager.saveTransactionLocally({
        category_id: tx.category_id,
        amount: Number(targetAmount.toFixed(2)),
        created_at: new Date().toISOString(),
        comment: tx.comment,
      });
      SyncRunner.syncWithBackend();
      // renderTimelineFromStore() will fire automatically via the transactions subscriber
    },
  });
}

/* ═══════════════════════════════════════════════════
   9. Online/Offline статус
═══════════════════════════════════════════════════ */

function initNetworkWatcher() {
  window.addEventListener('online', () => { Store.state.isOnline = true; });
  window.addEventListener('offline', () => { Store.state.isOnline = false; });
}

/* ═══════════════════════════════════════════════════
   10. Bootstrap — загрузка начального стейта с бэкенда
═══════════════════════════════════════════════════ */

async function bootstrap() {
  if (!Store.state.isOnline) return;

  try {
    const initData = tg?.initData || '';
    const res = await fetch('/api/v1/bootstrap', {
      headers: {
        'Authorization': `Telegram ${initData}`,
      },
    });

    if (!res.ok) throw new Error(`bootstrap: ${res.status}`);

    const data = await res.json();
    const budget = data.budget || {};

    // Merge server categories into local storage, deduped strictly by UUID
    const mergedCategories = StorageManager.mergeCategoriesFromServer(data.categories || [], true);

    Store.batchUpdate({
      currency: data.currency || 'RUB',
      weeklyLimit: budget.weekly_limit || 0,
      monthlyLimit: budget.monthly_limit || 0,
      categories: mergedCategories,
      rates: data.rates || {},
    });

    // Explicitly render carousel after Store update with fresh server data to ensure atomic UI refresh
    CategoryCarousel.render(mergedCategories);

    // Refresh analytics timeline if currently viewing that tab
    if (Store.state.currentTab === 'analytics') {
      loadAnalyticsData();
    }

  } catch (err) {
    // Offline-first: не блокируем UI, работаем с локальным состоянием
    console.warn('[App] Bootstrap failed, running offline:', err.message);
  }
}

/* ═══════════════════════════════════════════════════
   11. Initial Pull — скачивание истории при пустом хранилище
═══════════════════════════════════════════════════ */

async function initialPull() {
  if (!Store.state.isOnline) return;

  try {
    const initData = tg?.initData || '';
    const response = await fetch('/api/v1/analytics/timeline?limit=200', {
      headers: { 'Authorization': `Telegram ${initData}` },
    });
    if (!response.ok) return;

    const data = await response.json();
    if (!data?.items?.length) return;

    // mergeFromServer безопасен при любом состоянии localStorage:
    // добавляет новые записи и не затирает _pending-транзакции.
    StorageManager.mergeFromServer(data.items);

    if (Store.state.currentTab === 'analytics') loadAnalyticsData();
  } catch (err) {
    console.error('[App] Initial pull failed:', err);
  }
}

/* ═══════════════════════════════════════════════════
   12. Вспомогательные утилиты
═══════════════════════════════════════════════════ */

const CURRENCY_SYMBOLS = { RUB: '₽', GEL: '₾', USD: '$', EUR: '€' };

function getCurrencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '₽';
}

function formatCurrency(amount, currencyOrCode = 'RUB') {
  const num = Number(amount);
  const sym = getCurrencySymbol(currencyOrCode);
  return isNaN(num)
    ? '—'
    : num.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ' + sym;
}

/* ═══════════════════════════════════════════════════
   13. Инициализация приложения
═══════════════════════════════════════════════════ */

function hideSkeleton() {
  const skeleton = document.getElementById('skeleton');
  const app = document.getElementById('app');

  if (skeleton) {
    skeleton.classList.add('fade-out');
    setTimeout(() => { skeleton.style.display = 'none'; }, 280);
  }

  if (app) {
    app.classList.remove('hidden');
    // rAF → классы применятся отдельными кадрами, transition сработает
    requestAnimationFrame(() => app.classList.add('visible'));
  }
}

async function init() {
  // Порядок: SDK → тема → хранилище → биндинги → роутер → аналитика → данные
  initTelegram();
  initTheme();
  updateAnalyticsRange();   // вычисляем диапазон до первого рендера аналитики
  StorageManager.init();    // загружаем транзакции из localStorage до рендера
  Settings.init();          // лимиты + прогресс-бары
  BudgetCard.init();        // переключатель Неделя/Месяц
  initBindings();
  Router.init();
  NumPad.init();
  CategoryCreationSheet.init();
  CategoryCarousel.init();
  initAnalytics();          // свайпы + подписки вкладки аналитики
  initNetworkWatcher();

  // Показываем скелет минимум 400ms для плавности, потом грузим данные
  await Promise.all([
    bootstrap(),
    new Promise(r => setTimeout(r, 400)),
  ]);

  // Ensure carousel renders with final store state after bootstrap completes
  CategoryCarousel.render(Store.state.categories);

  hideSkeleton();
  initialPull();            // скачиваем историю, если localStorage пуст
  SyncRunner.start();       // запускаем фоновый воркер синхронизации
}

// Запуск после загрузки DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Глобальный экспорт для отладки в консоли
window.App = { Store, Router, StorageManager, SyncRunner, DonutChart, SwipeGesture, Settings, CalendarSheet, CategoryCreationSheet, formatCurrency, getCurrencySymbol };
