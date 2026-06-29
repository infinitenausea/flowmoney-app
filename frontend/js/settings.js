/**
 * FlowMoney — Budget Settings Module (Этап 5.3)
 *
 * Responsibilities:
 *  - Bind <input type="range"> sliders to Store
 *  - Persist limits to localStorage (survives server outages)
 *  - Best-effort PUT /api/v1/budgets (debounced, silent on failure)
 *  - Render weekly / monthly progress bars
 *  - Compute and push dailyAvailable into Store whenever limits or transactions change
 */

const Settings = (() => {
  const STORAGE_KEY = 'flowmoney_budgets';
  let _debounce = null;

  // ── Persistence ──────────────────────────────────────────────────────────

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _persist(weekly, monthly) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ weeklyLimit: weekly, monthlyLimit: monthly }));
    } catch (e) {
      console.warn('[Settings] persist failed:', e.message);
    }
  }

  // Best-effort sync — the spec has no /budgets endpoint yet, so failures are silent
  function _syncToServer(weekly, monthly) {
    clearTimeout(_debounce);
    _debounce = setTimeout(async () => {
      if (!navigator.onLine) return;
      try {
        const initData = window.Telegram?.WebApp?.initData || '';
        await fetch('/api/v1/budgets', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Telegram ${initData}` },
          body:    JSON.stringify({ weekly_limit: weekly, monthly_limit: monthly }),
        });
      } catch { /* silent */ }
    }, 1500);
  }

  // ── Daily available ──────────────────────────────────────────────────────

  function computeDailyAvailable() {
    const weekly  = Store.state.weeklyLimit  || 0;
    const monthly = Store.state.monthlyLimit || 0;
    if (!weekly && !monthly) return null;

    let dailyLimit = Infinity;
    if (weekly  > 0) dailyLimit = Math.min(dailyLimit, weekly  / 7);
    if (monthly > 0) dailyLimit = Math.min(dailyLimit, monthly / 30);
    if (!isFinite(dailyLimit)) dailyLimit = 0;

    Store.state.dailyLimit = dailyLimit;

    const today = new Date();
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const spent = (Store.state.transactions || [])
      .filter(tx => !tx.is_deleted && new Date(tx.created_at).getTime() >= todayMs)
      .reduce((s, tx) => s + Number(tx.amount), 0);

    return dailyLimit - spent;
  }

  // ── Progress bars ────────────────────────────────────────────────────────

  function renderProgressBars() {
    const txs = Store.state.transactions || [];
    const cur = Store.state.currency || '₽';
    const now = new Date();

    const wLimit = Store.state.weeklyLimit || 0;
    if (wLimit > 0) {
      const wStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
      wStart.setHours(0, 0, 0, 0);
      const wSpent = txs.filter(tx => !tx.is_deleted && new Date(tx.created_at) >= wStart)
                        .reduce((s, tx) => s + Number(tx.amount), 0);
      _updateBar('weekly-progress-bar', 'weekly-spend-display', wSpent, wLimit, cur);
    }

    const mLimit = Store.state.monthlyLimit || 0;
    if (mLimit > 0) {
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const mSpent = txs.filter(tx => !tx.is_deleted && new Date(tx.created_at) >= mStart)
                        .reduce((s, tx) => s + Number(tx.amount), 0);
      _updateBar('monthly-progress-bar', 'monthly-spend-display', mSpent, mLimit, cur);
    }
  }

  function _updateBar(barId, spendId, spent, limit, currency) {
    const bar = document.getElementById(barId);
    if (!bar) return;

    const pct = Math.min(100, (spent / limit) * 100);
    bar.style.width = pct + '%';
    bar.style.background = pct >= 90
      ? 'var(--danger-color)'
      : pct >= 65
        ? 'color-mix(in srgb, var(--danger-color) 55%, var(--success-color))'
        : 'var(--success-color)';

    const spendEl = document.getElementById(spendId);
    if (spendEl && typeof formatCurrency === 'function') {
      spendEl.textContent = formatCurrency(spent, currency);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // Pre-fill Store from localStorage so sliders show correct values
    // before the bootstrap response arrives
    const local = _load();
    if (local) {
      if (!Store.state.weeklyLimit  && local.weeklyLimit)  Store.state.weeklyLimit  = local.weeklyLimit;
      if (!Store.state.monthlyLimit && local.monthlyLimit) Store.state.monthlyLimit = local.monthlyLimit;
    }

    const weeklySlider   = document.getElementById('weekly-limit');
    const monthlySlider  = document.getElementById('monthly-limit');
    const weeklyDisplay  = document.getElementById('weekly-limit-display');
    const monthlyDisplay = document.getElementById('monthly-limit-display');

    // Slider → Store (input fires continuously during drag)
    if (weeklySlider) {
      weeklySlider.addEventListener('input', () => {
        Store.state.weeklyLimit = Number(weeklySlider.value);
      });
    }
    if (monthlySlider) {
      monthlySlider.addEventListener('input', () => {
        Store.state.monthlyLimit = Number(monthlySlider.value);
      });
    }

    // Store → Slider + display (handles server updates from bootstrap too)
    Store.subscribe('weeklyLimit', (val) => {
      if (weeklySlider)  weeklySlider.value = val || 0;
      if (weeklyDisplay && typeof formatCurrency === 'function') {
        weeklyDisplay.textContent = formatCurrency(val || 0, Store.state.currency);
      }
      _persist(val, Store.state.monthlyLimit);
      _syncToServer(val, Store.state.monthlyLimit);
      Store.state.dailyAvailable = computeDailyAvailable();
      renderProgressBars();
    });

    Store.subscribe('monthlyLimit', (val) => {
      if (monthlySlider)  monthlySlider.value = val || 0;
      if (monthlyDisplay && typeof formatCurrency === 'function') {
        monthlyDisplay.textContent = formatCurrency(val || 0, Store.state.currency);
      }
      _persist(Store.state.weeklyLimit, val);
      _syncToServer(Store.state.weeklyLimit, val);
      Store.state.dailyAvailable = computeDailyAvailable();
      renderProgressBars();
    });

    // Recalculate whenever transactions change (new spend / delete)
    Store.subscribe('transactions', () => {
      Store.state.dailyAvailable = computeDailyAvailable();
      renderProgressBars();
    });
  }

  return { init, computeDailyAvailable, renderProgressBars };
})();

window.Settings = Settings;
