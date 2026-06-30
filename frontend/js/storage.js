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

// One-time migration: converts legacy string category IDs (used before UUID system categories
// were introduced) to the stable UUIDs defined in migration 000002_seed_system_categories.
const LEGACY_CATEGORY_ID_MAP = {
  'food':      '11111111-1111-1111-1111-111111111101',
  'transport': '11111111-1111-1111-1111-111111111102',
  'shopping':  '11111111-1111-1111-1111-111111111103',
  'health':    '11111111-1111-1111-1111-111111111104',
  'cafe':      '11111111-1111-1111-1111-111111111105',
  'sport':     '11111111-1111-1111-1111-111111111106',
  'home':      '11111111-1111-1111-1111-111111111107',
  'other':     '11111111-1111-1111-1111-111111111108',
};

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

    // Migrate legacy string category IDs to stable UUIDs (one-time, in-place).
    let migrated = false;
    _transactions = _transactions.map(tx => {
      const newCatId = LEGACY_CATEGORY_ID_MAP[tx.category_id];
      if (newCatId) {
        migrated = true;
        return { ...tx, category_id: newCatId, synced: false, _pending: true };
      }
      return tx;
    });
    if (migrated) {
      _persist();
      console.info('[Storage] Migrated legacy category IDs to UUIDs');
    }

    Store.state.transactions = [..._transactions];
    console.info('[Storage] Loaded', _transactions.length, 'transaction(s) from localStorage');

    // Load user-created categories
    try {
      const rawCats = localStorage.getItem(CATEGORIES_KEY);
      _userCategories = rawCats ? JSON.parse(rawCats) : [];
    } catch (e) {
      console.warn('[Storage] Corrupt user categories, resetting:', e.message);
      _userCategories = [];
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
   * Возвращает категории, ещё не отправленные на сервер.
   * @returns {Object[]}
   */
  function getUnsyncedCategories() {
    return _userCategories.filter(c => !c.synced);
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

  return { init, saveTransactionLocally, getUnsyncedTransactions, markAsSynced, deleteLocally, bulkLoad, mergeFromServer, getLastSyncedAt, saveUserCategory, getUserCategories, getUnsyncedCategories, markCategoriesAsSynced, _dump };
})();

window.StorageManager = StorageManager;
