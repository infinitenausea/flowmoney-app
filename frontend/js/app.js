/**
 * FlowMoney — Точка входа SPA
 * Этап 3: Инициализация Telegram SDK, Theme Engine, SPA-роутер
 */

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
}

/* ═══════════════════════════════════════════════════
   2. Theme Engine — маппинг Telegram themeParams → CSS vars
      Таблица 4.1 из спецификации
═══════════════════════════════════════════════════ */

function applyTheme(params) {
  const root = document.documentElement;
  const p = params || {};

  // Основные переменные из спеки 4.1
  if (p.bg_color)           root.style.setProperty('--bg-color',            p.bg_color);
  if (p.secondary_bg_color) root.style.setProperty('--secondary-bg-color',  p.secondary_bg_color);
  if (p.text_color)         root.style.setProperty('--text-color',           p.text_color);
  if (p.hint_color)         root.style.setProperty('--hint-color',           p.hint_color);
  if (p.button_color)       root.style.setProperty('--accent-color',         p.button_color);

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
    home:      document.getElementById('screen-home'),
    analytics: document.getElementById('screen-analytics'),
    settings:  document.getElementById('screen-settings'),
  };

  const tabs = document.querySelectorAll('.nav-tab');
  let currentTab = 'home';

  function navigateTo(tabId) {
    if (tabId === currentTab) return;

    const prevTab = currentTab;
    currentTab = tabId;

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
    // Слушаем pointerdown для мгновенного отклика (спека 3.1)
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
  const MAX_DIGITS    = 6;   // 999999 — шесть цифр до запятой
  const MAX_DECIMALS  = 2;
  const MAX_AMOUNT    = 999999;

  function init() {
    const numpad = document.querySelector('.numpad');
    if (!numpad) return;

    // pointerdown для мгновенного отклика, без 300ms delay
    numpad.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('[data-key]');
      if (!key) return;

      e.preventDefault();

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
   5. Карусель категорий — рендер и выбор
═══════════════════════════════════════════════════ */

const CategoryCarousel = (() => {
  // Дефолтные категории до загрузки с бэкенда
  const DEFAULT_CATEGORIES = [
    { id: 'food',       name: 'Еда',       icon: '🍕', color: '#FF6B6B' },
    { id: 'transport',  name: 'Транспорт', icon: '🚇', color: '#4ECDC4' },
    { id: 'shopping',   name: 'Покупки',   icon: '🛍️',  color: '#45B7D1' },
    { id: 'health',     name: 'Здоровье',  icon: '💊', color: '#96CEB4' },
    { id: 'cafe',       name: 'Кафе',      icon: '☕', color: '#FFEAA7' },
    { id: 'sport',      name: 'Спорт',     icon: '⚽', color: '#DDA0DD' },
    { id: 'home',       name: 'Дом',       icon: '🏠', color: '#98D8C8' },
    { id: 'other',      name: 'Другое',    icon: '💡', color: '#B0C4DE' },
  ];

  function render(categories) {
    const carousel = document.getElementById('category-carousel');
    if (!carousel) return;

    carousel.innerHTML = categories.map(cat => `
      <div class="category-item" role="option" data-id="${cat.id}" aria-selected="false">
        <div class="category-icon" style="background:${cat.color}22; color:${cat.color}">
          ${cat.icon}
        </div>
        <span class="category-name">${cat.name}</span>
      </div>
    `).join('');

    carousel.addEventListener('pointerdown', (e) => {
      const item = e.target.closest('.category-item');
      if (!item) return;

      tg?.HapticFeedback?.impactOccurred('light');

      const prevSelected = carousel.querySelector('.category-item.selected');
      if (prevSelected) {
        prevSelected.classList.remove('selected');
        prevSelected.setAttribute('aria-selected', 'false');
      }

      item.classList.add('selected');
      item.setAttribute('aria-selected', 'true');
      Store.state.selectedCategory = item.dataset.id;
    });
  }

  function init() {
    // Сразу рисуем дефолтные, потом перерисуем с данными с бэкенда
    render(DEFAULT_CATEGORIES);

    // Реагируем на загрузку категорий с сервера
    Store.subscribe('categories', (cats) => {
      if (cats && cats.length > 0) render(cats);
    });
  }

  return { init };
})();

/* ═══════════════════════════════════════════════════
   6. Реактивные биндинги DOM ← Store
═══════════════════════════════════════════════════ */

function initBindings() {
  const amountDisplay   = document.getElementById('amount-display');
  const dailyAvailable  = document.getElementById('daily-available');
  const btnAdd          = document.getElementById('btn-add');
  const currencySymbol  = document.getElementById('currency-symbol');

  // Дисплей суммы
  Store.subscribe('inputAmount', (val) => {
    if (!amountDisplay) return;
    amountDisplay.textContent = val === '' ? '0' : val;
    updateAddButton();
  });

  // Выбор категории влияет на кнопку
  Store.subscribe('selectedCategory', () => updateAddButton());

  // Доступный дневной бюджет + цветовой градиент
  Store.subscribe('dailyAvailable', (val) => {
    if (!dailyAvailable) return;
    const limit = Store.state.dailyLimit;

    if (val === null || val === undefined) {
      dailyAvailable.textContent = '—';
      return;
    }

    const formatted = formatCurrency(val, Store.state.currency);
    dailyAvailable.textContent = formatted;

    // Цветовая семантика: зелёный → коралловый (спека 3.1)
    dailyAvailable.classList.remove('warning', 'danger');
    if (limit > 0) {
      const ratio = val / limit;
      if (ratio <= 0)    dailyAvailable.classList.add('danger');
      else if (ratio < 0.3) dailyAvailable.classList.add('warning');
    }
  });

  // Символ валюты
  Store.subscribe('currency', (val) => {
    if (currencySymbol) currencySymbol.textContent = val || '₽';
  });

  function updateAddButton() {
    if (!btnAdd) return;
    const amount = parseFloat(Store.state.inputAmount);
    const cat    = Store.state.selectedCategory;
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

  // Слайдеры лимитов (Экран 3)
  const weeklySlider  = document.getElementById('weekly-limit');
  const monthlySlider = document.getElementById('monthly-limit');
  const weeklyDisplay  = document.getElementById('weekly-limit-display');
  const monthlyDisplay = document.getElementById('monthly-limit-display');

  if (weeklySlider) {
    weeklySlider.addEventListener('input', () => {
      Store.state.weeklyLimit = Number(weeklySlider.value);
      if (weeklyDisplay) weeklyDisplay.textContent = formatCurrency(weeklySlider.value, Store.state.currency);
    });
    Store.subscribe('weeklyLimit', (val) => {
      weeklySlider.value = val || 0;
      if (weeklyDisplay) weeklyDisplay.textContent = formatCurrency(val || 0, Store.state.currency);
    });
  }

  if (monthlySlider) {
    monthlySlider.addEventListener('input', () => {
      Store.state.monthlyLimit = Number(monthlySlider.value);
      if (monthlyDisplay) monthlyDisplay.textContent = formatCurrency(monthlySlider.value, Store.state.currency);
    });
    Store.subscribe('monthlyLimit', (val) => {
      monthlySlider.value = val || 0;
      if (monthlyDisplay) monthlyDisplay.textContent = formatCurrency(val || 0, Store.state.currency);
    });
  }
}

/* ═══════════════════════════════════════════════════
   7. Транзакции — добавление
═══════════════════════════════════════════════════ */

function handleAddTransaction() {
  const amount = parseFloat(Store.state.inputAmount);
  const catId  = Store.state.selectedCategory;
  if (!amount || !catId) return;

  // Сохраняем локально — StorageManager сам обновит Store (оптимистичный апдейт)
  const tx = StorageManager.saveTransactionLocally({
    category_id: catId,
    amount,
    created_at:  new Date().toISOString(),
  });

  // Сбрасываем ввод
  Store.state.inputAmount      = '';
  Store.state.selectedCategory = null;

  // Сбрасываем выделение категории в DOM
  document.querySelectorAll('.category-item.selected').forEach(el => {
    el.classList.remove('selected');
    el.setAttribute('aria-selected', 'false');
  });

  console.info('[App] Transaction saved locally:', tx.id);

  // Внеочередная попытка синхронизации (не блокирует UI)
  SyncRunner.syncWithBackend();
}

/* ═══════════════════════════════════════════════════
   8. Online/Offline статус
═══════════════════════════════════════════════════ */

function initNetworkWatcher() {
  window.addEventListener('online',  () => { Store.state.isOnline = true; });
  window.addEventListener('offline', () => { Store.state.isOnline = false; });
}

/* ═══════════════════════════════════════════════════
   9. Bootstrap — загрузка начального стейта с бэкенда
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

    Store.batchUpdate({
      currency:       data.currency      || '₽',
      dailyAvailable: data.daily_available,
      dailyLimit:     data.daily_limit   || 0,
      weeklyLimit:    data.weekly_limit  || 0,
      monthlyLimit:   data.monthly_limit || 0,
      categories:     data.categories   || [],
    });

  } catch (err) {
    // Offline-first: не блокируем UI, работаем с локальным состоянием
    console.warn('[App] Bootstrap failed, running offline:', err.message);
  }
}

/* ═══════════════════════════════════════════════════
   10. Вспомогательные утилиты
═══════════════════════════════════════════════════ */

function formatCurrency(amount, currency = '₽') {
  const num = Number(amount);
  return isNaN(num)
    ? '—'
    : num.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ' + currency;
}

/* ═══════════════════════════════════════════════════
   11. Инициализация приложения
═══════════════════════════════════════════════════ */

function hideSkeleton() {
  const skeleton = document.getElementById('skeleton');
  const app      = document.getElementById('app');

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
  // Порядок важен: SDK → тема → хранилище → DOM-биндинги → роутер → данные
  initTelegram();
  initTheme();
  StorageManager.init();    // Загружаем транзакции из localStorage до рендера
  initBindings();
  Router.init();
  NumPad.init();
  CategoryCarousel.init();
  initNetworkWatcher();

  // Показываем скелет минимум 400ms для плавности, потом грузим данные
  await Promise.all([
    bootstrap(),
    new Promise(r => setTimeout(r, 400)),
  ]);

  hideSkeleton();
  SyncRunner.start();       // Запускаем фоновый воркер синхронизации
}

// Запуск после загрузки DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Глобальный экспорт для отладки в консоли
window.App = { Store, Router, StorageManager, SyncRunner, formatCurrency };
