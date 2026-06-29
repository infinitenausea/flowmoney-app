/**
 * FlowMoney — Background Sync Runner (Этап 4.3)
 *
 * Фоновый воркер, отправляющий локальные пакеты на /api/v1/sync.
 * UI никогда не блокируется при ошибках сети.
 * Стратегия: периодический интервал (15 с) + срабатывание при возврате сети.
 */

const SyncRunner = (() => {
  const SYNC_INTERVAL_MS = 15_000;
  let _timer = null;
  let _isSyncing = false;

  /**
   * Собирает неотправленные транзакции и отправляет пакет на бэкенд.
   * Идемпотентно: повторный вызов безопасен (бэкенд использует ON CONFLICT DO UPDATE).
   */
  async function syncWithBackend() {
    if (_isSyncing) return;

    const pending = StorageManager.getUnsyncedTransactions();
    if (pending.length === 0) return;

    _isSyncing = true;

    try {
      const initData = window.Telegram?.WebApp?.initData || '';

      const res = await fetch('/api/v1/sync', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Telegram ${initData}`,
        },
        body: JSON.stringify({ transactions: pending }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const syncedIds = pending.map(tx => tx.id);
      StorageManager.markAsSynced(syncedIds);

      Store.state.isOnline = true;
      console.info('[Sync] Synced', syncedIds.length, 'transaction(s)');

    } catch (err) {
      // Offline-first: тихо проглатываем ошибку, повторим позже
      console.warn('[Sync] Failed, will retry:', err.message);
    } finally {
      _isSyncing = false;
    }
  }

  /**
   * Запускает фоновый воркер:
   * — слушает событие возврата сети
   * — устанавливает периодический интервал
   * — делает немедленную попытку синхронизации
   */
  function start() {
    window.addEventListener('online', syncWithBackend);
    _timer = setInterval(syncWithBackend, SYNC_INTERVAL_MS);

    // Немедленная попытка, если уже есть сеть
    if (navigator.onLine) syncWithBackend();
  }

  /**
   * Останавливает воркер (для тестов и размонтирования).
   */
  function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    window.removeEventListener('online', syncWithBackend);
  }

  return { syncWithBackend, start, stop };
})();

window.SyncRunner = SyncRunner;
