/**
 * FlowMoney — Local Storage Manager (Этап 4.2)
 *
 * Единственный владелец персистентного слоя транзакций.
 * Все записи хранятся в localStorage под ключом STORAGE_KEY.
 * Store.state.transactions — зеркало этого массива (source of truth: localStorage).
 */

const STORAGE_KEY = 'flowmoney_transactions';

const StorageManager = (() => {
  let _transactions = [];

  function _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_transactions));
    } catch (e) {
      console.warn('[Storage] Failed to persist:', e.message);
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
   * Возвращает снимок всех транзакций (только для отладки).
   */
  function _dump() {
    return JSON.parse(JSON.stringify(_transactions));
  }

  return { init, saveTransactionLocally, getUnsyncedTransactions, markAsSynced, deleteLocally, _dump };
})();

window.StorageManager = StorageManager;
