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
   * Отправляет локальные pending-транзакции на бэкенд (POST /api/v1/sync).
   * Идемпотентно: бэкенд использует ON CONFLICT DO UPDATE.
   */
  async function _push(initData) {
    const pending = StorageManager.getUnsyncedTransactions();
    const pendingCats = StorageManager.getUnsyncedCategories();
    if (pending.length === 0 && pendingCats.length === 0) return;

    const res = await fetch('/api/v1/sync', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Telegram ${initData}`,
      },
      body: JSON.stringify({
        transactions: pending,
        categories: pendingCats.map(c => ({
          id:         c.id,
          name:       c.name,
          color:      c.color,
          icon:       c.icon,
          sort_order: c.sort_order,
          is_deleted: c.is_deleted === true,
        })),
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (pending.length) {
      StorageManager.markAsSynced(pending.map(tx => tx.id));
      console.info('[Sync] Pushed', pending.length, 'transaction(s)');
    }
    if (pendingCats.length) {
      StorageManager.markCategoriesAsSynced(pendingCats.map(c => c.id));
      console.info('[Sync] Pushed', pendingCats.length, 'category(ies)');
    }
  }

  /**
   * Скачивает последние транзакции с бэкенда и мержит в localStorage.
   * Это позволяет десктопному клиенту видеть транзакции, добавленные с мобильного.
   */
  async function _pull(initData) {
    const headers = { 'Authorization': `Telegram ${initData}` };

    // Fetch categories delta alongside transactions so newly created/renamed
    // categories on other devices resolve immediately instead of showing "Unknown".
    const [txRes, bootstrapRes] = await Promise.all([
      fetch(
        StorageManager.getLastSyncedAt()
          ? `/api/v1/analytics/timeline?since=${encodeURIComponent(StorageManager.getLastSyncedAt())}`
          : '/api/v1/analytics/timeline?limit=200',
        { headers }
      ),
      fetch('/api/v1/bootstrap', { headers }),
    ]);

    if (bootstrapRes.ok) {
      const bData = await bootstrapRes.json();
      // Use ?? so an explicit null/undefined falls back to []; an explicit [] is preserved.
      const serverCats = bData.categories ?? [];
      // Always merge — even when serverCats is [] — so that categories deleted on another
      // device are evicted from the local cache immediately without a page reload.
      StorageManager.mergeCategoriesFromServer(serverCats, false);
      if (serverCats.length) {
        console.info('[Sync] Pulled', serverCats.length, 'category(ies)');
      }
    }

    if (!txRes.ok) return;

    const data = await txRes.json();
    if (data?.items?.length) {
      StorageManager.mergeFromServer(data.items);
      console.info('[Sync] Pulled', data.items.length, 'transaction(s)');
    }
  }

  /**
   * Двунаправленная синхронизация: сначала пушит локальные изменения,
   * затем тянет серверные — чтобы изменения с других устройств попали в UI.
   * Идемпотентно: повторный вызов безопасен.
   */
  async function syncWithBackend() {
    if (_isSyncing) return;
    _isSyncing = true;

    try {
      const initData = window.Telegram?.WebApp?.initData || '';
      await _push(initData);
      await _pull(initData);
      Store.state.isOnline = true;
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
