/**
 * FlowMoney — Local Storage Manager (Этап 4.2)
 *
 * Единственный владелец персистентного слоя транзакций.
 * Все записи хранятся в localStorage под ключом STORAGE_KEY.
 * Store.state.transactions — зеркало этого массива (source of truth: localStorage).
 */

const STORAGE_KEY = 'flowmoney_transactions';
const LAST_SYNCED_AT_KEY = 'flowmoney_last_synced_at';
const CATEGORIES_KEY = 'flowmoney_user_categories';


const StorageManager = (() => {
  let _transactions = [];
  let _userCategories = [];

  function _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_transactions));
    } catch (e) {
      console.warn('[Storage] Failed to persist:', e.message);
    }
  }

  function _persistLastSyncedAt(ts) {
    try {
      localStorage.setItem(LAST_SYNCED_AT_KEY, ts);
    } catch (e) {
      console.warn('[Storage] Failed to persist last_synced_at:', e.message);
    }
  }

  /**
   * Загружает транзакции из localStorage в память и синхронизирует Store.
   * Вызывать один раз при старте приложения до рендеринга UI.
   */
  function init() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      _transactions = raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('[Storage] Corrupt localStorage data, resetting:', e.message);
      _transactions = [];
    }

    Store.state.transactions = [..._transactions];
    console.info('[Storage] Loaded', _transactions.length, 'transaction(s) from localStorage');

    // Migration: evict cached data that pre-dates the `synced` field
    try {
      const rawMigCheck = localStorage.getItem(CATEGORIES_KEY);
      if (rawMigCheck) {
        const parsed = JSON.parse(rawMigCheck);
        const hasLegacy = Array.isArray(parsed) && parsed.some(c => !('synced' in c));
        if (hasLegacy) {
          localStorage.removeItem(CATEGORIES_KEY);
          console.info('[Storage] Evicted legacy user categories (missing synced field)');
        }
      }
    } catch (e) { /* ignore — next block will handle corrupt data */ }

    // Load user-created categories
    try {
      const rawCats = localStorage.getItem(CATEGORIES_KEY);
      _userCategories = rawCats ? JSON.parse(rawCats) : [];
    } catch (e) {
      console.warn('[Storage] Corrupt user categories, resetting:', e.message);
      _userCategories = [];
    }

    // First run: seed three default categories so the carousel is never empty.
    if (_userCategories.length === 0) {
      _userCategories = [
        { id: self.crypto.randomUUID(), name: 'Продукты',  icon: '🛒', color: '#4ECDC4', sort_order: 0, synced: false },
        { id: self.crypto.randomUUID(), name: 'Транспорт', icon: '🚗', color: '#45B7D1', sort_order: 1, synced: false },
        { id: self.crypto.randomUUID(), name: 'Кафе',      icon: '☕', color: '#FFB347', sort_order: 2, synced: false },
      ];
      try {
        localStorage.setItem(CATEGORIES_KEY, JSON.stringify(_userCategories));
      } catch (e) {
        console.warn('[Storage] Failed to seed default categories:', e.message);
      }
      console.info('[Storage] Seeded 3 default categories (first run)');
    }
  }

  /**
   * Сохраняет транзакцию локально со статусом synced: false.
   * Генерирует UUID v4 на клиенте (для поддержки offline).
   * @param {{ category_id: string, amount: number, created_at?: string }} txPartial
   * @returns {Object} Полная запись транзакции
   */
  function saveTransactionLocally(txPartial) {
    const tx = {
      id:          self.crypto.randomUUID(),
      category_id: txPartial.category_id,
      amount:      txPartial.amount,
      currency:    Store.state.currency || 'RUB',
      created_at:  txPartial.created_at || new Date().toISOString(),
      comment:     txPartial.comment || undefined,
      is_deleted:  false,
      synced:      false,
      _pending:    true,
    };

    _transactions.unshift(tx);
    _persist();

    // Оптимистичный апдейт Store — UI обновляется мгновенно
    Store.state.transactions = [..._transactions];

    return tx;
  }

  /**
   * Возвращает все транзакции, ещё не отправленные на сервер.
   * @returns {Object[]}
   */
  function getUnsyncedTransactions() {
    return _transactions.filter(tx => !tx.synced);
  }

  /**
   * Помечает указанные транзакции как синхронизированные.
   * @param {string[]} ids — массив UUID транзакций
   */
  function markAsSynced(ids) {
    const idSet = new Set(ids);
    let changed = false;

    _transactions = _transactions.map(tx => {
      if (idSet.has(tx.id)) {
        changed = true;
        return { ...tx, synced: true, _pending: false };
      }
      return tx;
    });

    if (changed) {
      _persist();
      // Обновляем Store — иконка ожидания пропадёт
      Store.state.transactions = [..._transactions];
    }
  }

  /**
   * Мягкое удаление: помечает транзакцию как удалённую и сбрасывает synced.
   * @param {string} id
   */
  function deleteLocally(id) {
    _transactions = _transactions.map(tx =>
      tx.id === id ? { ...tx, is_deleted: true, synced: false, _pending: true } : tx
    );
    _persist();
    Store.state.transactions = [..._transactions];
  }

  /**
   * Загружает массив транзакций, полученных с сервера, в пустое хранилище.
   * Вызывать только когда _transactions пуст (initial pull).
   * @param {Object[]} items — транзакции из API (уже синхронизированы)
   */
  function bulkLoad(items) {
    if (_transactions.length > 0) return;
    _transactions = items.map(tx => ({ ...tx, synced: true, _pending: false }));
    _persist();
    Store.state.transactions = [..._transactions];
  }

  /**
   * Мержит транзакции с сервера (дельта или полный список) в локальное хранилище.
   * — Транзакции с is_deleted: true удаляются из локального массива.
   * — Новые записи (нет в localStorage) добавляются.
   * — Существующие не-pending записи обновляются до серверной версии.
   * — Записи с _pending: true не трогаются (оптимистичный апдейт в полёте).
   * — last_synced_at обновляется самым свежим updated_at из пришедших записей.
   * @param {Object[]} items — транзакции из API
   */
  function mergeFromServer(items) {
    if (!items || items.length === 0) return;

    const localMap = new Map(_transactions.map(tx => [tx.id, tx]));
    let changed = false;
    let latestUpdatedAt = null;

    items.forEach(serverTx => {
      // Отслеживаем самый свежий updated_at для last_synced_at
      if (serverTx.updated_at) {
        if (!latestUpdatedAt || serverTx.updated_at > latestUpdatedAt) {
          latestUpdatedAt = serverTx.updated_at;
        }
      }

      if (serverTx.is_deleted) {
        // Удаляем запись, о которой сервер сообщил как об удалённой
        if (localMap.has(serverTx.id)) {
          localMap.delete(serverTx.id);
          changed = true;
        }
        return;
      }

      const local = localMap.get(serverTx.id);
      // Preserve currency from local record — server never sends this field.
      // For brand-new server-only records fall back to current app currency.
      const currency = (local && local.currency) || serverTx.currency || Store.state.currency || 'RUB';
      const normalized = { ...serverTx, amount: parseFloat(serverTx.amount) || 0, currency, synced: true, _pending: false };
      if (!local) {
        localMap.set(serverTx.id, normalized);
        changed = true;
      } else if (!local._pending) {
        localMap.set(serverTx.id, normalized);
        changed = true;
      }
      // local._pending === true: запись ждёт отправки — сервер не перезаписывает
    });

    if (latestUpdatedAt) {
      _persistLastSyncedAt(latestUpdatedAt);
    }

    if (changed) {
      _transactions = Array.from(localMap.values());
      _persist();
      Store.state.transactions = [..._transactions];
    }
  }

  /**
   * Возвращает метку времени последней успешной синхронизации (RFC3339) или null.
   * @returns {string|null}
   */
  function getLastSyncedAt() {
    return localStorage.getItem(LAST_SYNCED_AT_KEY) || null;
  }

  /**
   * Сохраняет пользовательскую категорию локально и обновляет Store.
   * @param {{ id: string, name: string, icon: string, color: string, is_system: boolean, sort_order: number }} cat
   */
  function saveUserCategory(cat) {
    const entry = { ...cat, synced: false };
    _userCategories.push(entry);
    try {
      localStorage.setItem(CATEGORIES_KEY, JSON.stringify(_userCategories));
    } catch (e) {
      console.warn('[Storage] Failed to persist user categories:', e.message);
    }
    Store.state.categories = [...(Store.state.categories || []), entry];
  }

  /**
   * Обновляет существующую пользовательскую категорию (редактирование / мягкое удаление).
   * @param {Object} cat — категория с обновлёнными полями; cat.id должен существовать
   */
  function updateUserCategory(cat) {
    const idx = _userCategories.findIndex(c => String(c.id) === String(cat.id));
    if (idx === -1) return;
    _userCategories[idx] = { ...cat, synced: false };
    try {
      localStorage.setItem(CATEGORIES_KEY, JSON.stringify(_userCategories));
    } catch (e) {
      console.warn('[Storage] Failed to persist user categories:', e.message);
    }
    Store.state.categories = (Store.state.categories || []).map(c =>
      c.id === cat.id ? _userCategories[idx] : c
    );
  }

  /**
   * Мержит категории с сервера в локальное хранилище, индексируя строго по UUID.
   * — Серверная версия перезаписывает локальную, КРОМЕ случая, когда локальная
   *   запись ещё не синхронизирована (synced: false) — она в полёте и не должна
   *   быть затёрта устаревшими серверными данными (та же логика, что и для транзакций).
   * — Сравнение id всегда идёт по строке, чтобы избежать дублей из-за разного типа/регистра.
   * @param {Object[]} serverCats — категории из API
   * @returns {Object[]} актуальный список пользовательских категорий
   */
  function mergeCategoriesFromServer(serverCats) {
    if (!serverCats || serverCats.length === 0) return getUserCategories();

    const localMap = new Map(_userCategories.map(c => [String(c.id), c]));
    let changed = false;

    // Evict categories that were confirmed synced but are absent from the authoritative
    // server list — they were hard-deleted on the server and must not be pushed back.
    const serverIds = new Set(serverCats.map(c => String(c.id)));
    for (const [id, local] of localMap) {
      if (local.synced === true && !serverIds.has(id)) {
        localMap.delete(id);
        changed = true;
      }
    }

    serverCats.forEach(serverCat => {
      const id = String(serverCat.id);
      const local = localMap.get(id);

      if (serverCat.is_deleted === true) {
        if (localMap.has(id)) { localMap.delete(id); changed = true; }
        return;
      }

      if (local && local.synced === false) {
        // Локальная запись ещё не отправлена/подтверждена — не трогаем.
        return;
      }

      localMap.set(id, { ...serverCat, id, synced: true });
      changed = true;
    });

    // Evict locally soft-deleted categories that have been confirmed synced —
    // the server will no longer include them in its response, so they are done.
    for (const [id, local] of localMap) {
      if (local.is_deleted === true && local.synced === true) {
        localMap.delete(id);
        changed = true;
      }
    }

    _userCategories = Array.from(localMap.values());

    if (changed) {
      try {
        localStorage.setItem(CATEGORIES_KEY, JSON.stringify(_userCategories));
      } catch (e) {
        console.warn('[Storage] Failed to persist merged categories:', e.message);
      }
    }

    return getUserCategories();
  }

  /**
   * Возвращает категории, ещё не отправленные на сервер.
   * @returns {Object[]}
   */
  function getUnsyncedCategories() {
    return _userCategories.filter(c => !c.synced || c.is_deleted === true);
  }

  /**
   * Помечает указанные категории как синхронизированные и сохраняет в localStorage.
   * @param {string[]} ids
   */
  function markCategoriesAsSynced(ids) {
    const idSet = new Set(ids);
    let changed = false;
    _userCategories = _userCategories.map(c => {
      if (idSet.has(c.id)) { changed = true; return { ...c, synced: true }; }
      return c;
    });
    if (changed) {
      try {
        localStorage.setItem(CATEGORIES_KEY, JSON.stringify(_userCategories));
      } catch (e) {
        console.warn('[Storage] Failed to persist user categories:', e.message);
      }
    }
  }

  /**
   * Возвращает копию массива пользовательских категорий.
   * @returns {Object[]}
   */
  function getUserCategories() {
    return [..._userCategories];
  }

  /**
   * Возвращает снимок всех транзакций (только для отладки).
   */
  function _dump() {
    return JSON.parse(JSON.stringify(_transactions));
  }

  return { init, saveTransactionLocally, getUnsyncedTransactions, markAsSynced, deleteLocally, bulkLoad, mergeFromServer, getLastSyncedAt, saveUserCategory, updateUserCategory, getUserCategories, getUnsyncedCategories, markCategoriesAsSynced, mergeCategoriesFromServer, _dump };
})();

window.StorageManager = StorageManager;
