/**
 * FlowMoney — Budget Settings Module
 *
 * Responsibilities:
 *  - Currency <select> → Store.state.currency → server sync
 *  - Tappable limit buttons → bottom-sheet modal with reused numpad logic
 *  - Persist limits + currency to localStorage (offline-first)
 *  - Best-effort PUT /api/v1/settings (debounced, silent on failure)
 *  - Weekly / monthly progress bars
 *  - Compute and push dailyAvailable into Store when limits or transactions change
 */

const Settings = (() => {
  const STORAGE_KEY = 'flowmoney_budgets';

  let _debounce   = null;
  let _editingLimit = null; // 'daily' | 'weekly' | 'monthly'
  let _budgetInput  = '';

  let _activeCurrencyTarget = null; // 'main' | 'from' | 'to'
  let _converterFrom = 'RUB';
  let _converterTo   = 'USD';

  const MAX_DIGITS   = 7;
  const MAX_DECIMALS = 2;
  const MAX_AMOUNT   = 9999999;

  // ── Persistence ──────────────────────────────────────────────────────────

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _persist(daily, weekly, monthly) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        dailyLimit:   daily,
        weeklyLimit:  weekly,
        monthlyLimit: monthly,
      }));
    } catch (e) {
      console.warn('[Settings] persist failed:', e.message);
    }
  }

  function _syncToServer() {
    clearTimeout(_debounce);
    _debounce = setTimeout(async () => {
      if (!navigator.onLine) return;
      try {
        const initData = window.Telegram?.WebApp?.initData || '';
        await fetch('/api/v1/settings', {
          method:  'PUT',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Telegram ${initData}`,
          },
          body: JSON.stringify({
            currency:      Store.state.currency      || 'RUB',
            daily_limit:   Store.state.dailyLimit    || 0,
            weekly_limit:  Store.state.weeklyLimit   || 0,
            monthly_limit: Store.state.monthlyLimit  || 0,
          }),
        });
      } catch { /* silent — offline-first */ }
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

    const today   = new Date();
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const spent   = (Store.state.transactions || [])
      .filter(tx => !tx.is_deleted && new Date(tx.created_at).getTime() >= todayMs)
      .reduce((s, tx) => s + Number(tx.amount), 0);

    return dailyLimit - spent;
  }

  // ── Progress bars ────────────────────────────────────────────────────────

  function renderProgressBars() {
    const txs = Store.state.transactions || [];
    const cur = Store.state.currency || 'RUB';
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

  // ── Limit display helper ─────────────────────────────────────────────────

  function _refreshLimitDisplays() {
    const cur = Store.state.currency || 'RUB';
    const fmt = typeof formatCurrency === 'function' ? formatCurrency : (v) => String(v);

    const d = document.getElementById('daily-limit-display');
    const w = document.getElementById('weekly-limit-display');
    const m = document.getElementById('monthly-limit-display');

    if (d) d.textContent = (Store.state.dailyLimit   > 0) ? fmt(Store.state.dailyLimit,   cur) : '—';
    if (w) w.textContent = (Store.state.weeklyLimit  > 0) ? fmt(Store.state.weeklyLimit,  cur) : '—';
    if (m) m.textContent = (Store.state.monthlyLimit > 0) ? fmt(Store.state.monthlyLimit, cur) : '—';
  }

  // ── Modal ────────────────────────────────────────────────────────────────

  const _TITLES = {
    daily:   'Дневной лимит',
    weekly:  'Недельный лимит',
    monthly: 'Месячный лимит',
  };

  function _openModal(limitType) {
    _editingLimit = limitType;

    let initialAmount = '';
    let title         = _TITLES[limitType] || 'Лимит';
    let currencyCode  = Store.state.currency || 'RUB';

    if (limitType === 'converter') {
      const fromEl  = document.getElementById('converter-from-amount');
      const text    = fromEl ? fromEl.textContent : '0';
      initialAmount = (text && text !== '0') ? text : '';
      title         = 'Сумма';
      currencyCode  = _converterFrom;
    } else {
      const currentVal = {
        daily:   Store.state.dailyLimit   || 0,
        weekly:  Store.state.weeklyLimit  || 0,
        monthly: Store.state.monthlyLimit || 0,
      }[limitType] || 0;
      initialAmount = currentVal > 0 ? String(Math.round(currentVal * 100) / 100) : '';
    }

    _budgetInput = initialAmount;

    const modal    = document.getElementById('budget-modal');
    const titleEl  = document.getElementById('budget-modal-title');
    const amountEl = document.getElementById('budget-modal-amount');
    const curEl    = document.getElementById('budget-modal-currency');

    if (titleEl)  titleEl.textContent  = title;
    if (amountEl) amountEl.textContent = _budgetInput || '0';
    if (curEl) {
      curEl.textContent = typeof getCurrencySymbol === 'function'
        ? getCurrencySymbol(currencyCode)
        : (currencyCode || '₽');
    }

    if (modal) {
      modal.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => modal.classList.add('open'));
    }

    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  }

  function _closeModal() {
    const modal = document.getElementById('budget-modal');
    if (modal) {
      modal.classList.remove('open');
      setTimeout(() => modal.setAttribute('aria-hidden', 'true'), 340);
    }
    _editingLimit = null;
    _budgetInput  = '';
  }

  function _handleBudgetKey(key) {
    if (key === 'backspace') {
      _budgetInput = _budgetInput.slice(0, -1);
    } else if (key === '.') {
      if (_budgetInput.includes('.')) return;
      _budgetInput = _budgetInput === '' ? '0.' : _budgetInput + '.';
    } else {
      const parts = _budgetInput.split('.');
      if (!_budgetInput.includes('.') && parts[0].length >= MAX_DIGITS) return;
      if (parts[1] !== undefined && parts[1].length >= MAX_DECIMALS)     return;
      const next = _budgetInput === '0' ? key : _budgetInput + key;
      if (parseFloat(next) > MAX_AMOUNT) return;
      _budgetInput = next;
    }

    const amountEl = document.getElementById('budget-modal-amount');
    if (amountEl) amountEl.textContent = _budgetInput || '0';

    if (_editingLimit === 'converter') _updateConverterResult();
  }

  function _saveLimit() {
    if (!_editingLimit) return;

    if (_editingLimit === 'converter') {
      const fromEl = document.getElementById('converter-from-amount');
      if (fromEl) fromEl.textContent = _budgetInput || '0';
      _updateConverterResult();
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
      _closeModal();
      return;
    }

    const amount   = parseFloat(_budgetInput) || 0;
    const storeKey = { daily: 'dailyLimit', weekly: 'weeklyLimit', monthly: 'monthlyLimit' }[_editingLimit];

    Store.state[storeKey] = amount;
    _persist(Store.state.dailyLimit, Store.state.weeklyLimit, Store.state.monthlyLimit);
    _syncToServer();

    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
    _closeModal();
  }

  // ── Converter ────────────────────────────────────────────────────────────

  function _updateConverterResult() {
    const fromEl = document.getElementById('converter-from-amount');
    const toEl   = document.getElementById('converter-to-amount');
    if (!toEl) return;

    const rates  = Store.state.rates || {};
    const amount = parseFloat(fromEl ? fromEl.textContent : '0') || 0;

    if (!rates[_converterFrom] || !rates[_converterTo] || amount === 0) {
      toEl.textContent = '0';
      return;
    }

    const result = amount / rates[_converterFrom] * rates[_converterTo];
    toEl.textContent = result.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }

  // ── Currency labels ───────────────────────────────────────────────────────

  const _CURRENCY_LABELS = {
    RUB: '₽ Российский рубль',
    GEL: '₾ Грузинский лари',
    USD: '$ Доллар США',
    EUR: '€ Евро',
  };

  const _CURRENCY_COMPACT = {
    RUB: '₽ RUB',
    GEL: '₾ GEL',
    USD: '$ USD',
    EUR: '€ EUR',
  };

  // ── Currency bottom sheet ─────────────────────────────────────────────────

  function _openCurrencySheet(target) {
    _activeCurrencyTarget = target || 'main';
    const sheet = document.getElementById('currency-options-sheet');
    if (!sheet) return;

    let activeCur;
    if (_activeCurrencyTarget === 'from')      activeCur = _converterFrom;
    else if (_activeCurrencyTarget === 'to')   activeCur = _converterTo;
    else                                        activeCur = Store.state.currency || 'RUB';

    sheet.querySelectorAll('.currency-sheet-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.currency === activeCur);
    });
    sheet.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => sheet.classList.add('active'));
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  }

  function _closeCurrencySheet() {
    const sheet = document.getElementById('currency-options-sheet');
    if (!sheet) return;
    sheet.classList.remove('active');
    setTimeout(() => sheet.setAttribute('aria-hidden', 'true'), 340);
  }

  function _handleCurrencyChange(newCurrency) {
    const oldCurrency = Store.state.currency || 'RUB';
    const rates       = Store.state.rates    || {};
    const rateFrom    = rates[oldCurrency];
    const rateTo      = rates[newCurrency];

    if (oldCurrency !== newCurrency && rateFrom && rateTo) {
      const factor     = rateTo / rateFrom;
      const newDaily   = Math.round((Store.state.dailyLimit   || 0) * factor * 100) / 100;
      const newWeekly  = Math.round((Store.state.weeklyLimit  || 0) * factor * 100) / 100;
      const newMonthly = Math.round((Store.state.monthlyLimit || 0) * factor * 100) / 100;
      Store.batchUpdate({ currency: newCurrency, dailyLimit: newDaily, weeklyLimit: newWeekly, monthlyLimit: newMonthly });
      _persist(newDaily, newWeekly, newMonthly);
    } else {
      Store.state.currency = newCurrency;
    }

    _syncToServer();
    window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // Pre-fill Store from localStorage before bootstrap arrives
    const local = _load();
    if (local) {
      if (!Store.state.dailyLimit   && local.dailyLimit)   Store.state.dailyLimit   = local.dailyLimit;
      if (!Store.state.weeklyLimit  && local.weeklyLimit)  Store.state.weeklyLimit  = local.weeklyLimit;
      if (!Store.state.monthlyLimit && local.monthlyLimit) Store.state.monthlyLimit = local.monthlyLimit;
    }

    // ── Currency custom select ───────────────────────────────────────────
    const customCurrencyBtn = document.getElementById('custom-currency-select');
    const customCurrencyLbl = document.getElementById('custom-currency-label');

    Store.subscribe('currency', (val) => {
      // Update custom select button label
      if (customCurrencyLbl && val) {
        customCurrencyLbl.textContent = _CURRENCY_LABELS[val] || val;
      }

      // Sync selected state inside the sheet (even when closed)
      document.querySelectorAll('.currency-sheet-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.currency === val);
      });

      // Update modal currency symbol if currently open
      const curEl = document.getElementById('budget-modal-currency');
      if (curEl) {
        curEl.textContent = typeof getCurrencySymbol === 'function'
          ? getCurrencySymbol(val)
          : (val || '₽');
      }

      // Keep converter from-currency in sync with main currency
      if (val) {
        _converterFrom = val;
        const fromLabel = document.getElementById('converter-from-label');
        if (fromLabel) fromLabel.textContent = _CURRENCY_COMPACT[val] || val;
      }

      _refreshLimitDisplays();
      renderProgressBars();
      _updateConverterResult();
    });

    if (customCurrencyBtn) {
      customCurrencyBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        _openCurrencySheet('main');
      });
    }

    // ── Currency sheet options ───────────────────────────────────────────
    const currencySheet = document.getElementById('currency-options-sheet');
    if (currencySheet) {
      currencySheet.querySelector('.bottom-sheet-backdrop')
        ?.addEventListener('pointerdown', (e) => { e.preventDefault(); _closeCurrencySheet(); });

      currencySheet.querySelectorAll('.currency-sheet-option').forEach(opt => {
        opt.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const newCur = opt.dataset.currency;
          if (!newCur) return;

          if (_activeCurrencyTarget === 'from') {
            _converterFrom = newCur;
            const label = document.getElementById('converter-from-label');
            if (label) label.textContent = _CURRENCY_COMPACT[newCur] || newCur;
            _updateConverterResult();
          } else if (_activeCurrencyTarget === 'to') {
            _converterTo = newCur;
            const label = document.getElementById('converter-to-label');
            if (label) label.textContent = _CURRENCY_COMPACT[newCur] || newCur;
            _updateConverterResult();
          } else {
            _handleCurrencyChange(newCur);
          }
          _closeCurrencySheet();
        });
      });
    }

    // ── Limit tap buttons ────────────────────────────────────────────────
    document.querySelectorAll('.limit-value--tap').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        _openModal(btn.dataset.limit);
      });
    });

    // ── Modal controls ───────────────────────────────────────────────────
    const closeBtn = document.getElementById('budget-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); _closeModal(); });
    }

    const backdrop = document.querySelector('.budget-modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); _closeModal(); });
    }

    const saveBtn = document.getElementById('budget-modal-save');
    if (saveBtn) {
      saveBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); _saveLimit(); });
    }

    // ── Modal numpad (reuses same CSS classes, separate event delegation) ─
    const modalNumpad = document.querySelector('.numpad--modal');
    if (modalNumpad) {
      modalNumpad.addEventListener('pointerdown', (e) => {
        const key = e.target.closest('[data-key]');
        if (!key) return;
        e.preventDefault();
        key.classList.add('pressed');
        setTimeout(() => key.classList.remove('pressed'), 120);
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
        _handleBudgetKey(key.dataset.key);
      });
    }

    // ── Store → limit displays ───────────────────────────────────────────
    Store.subscribe('dailyLimit', () => {
      _refreshLimitDisplays();
      Store.state.dailyAvailable = computeDailyAvailable();
    });

    Store.subscribe('weeklyLimit', (val) => {
      _refreshLimitDisplays();
      _persist(Store.state.dailyLimit, val, Store.state.monthlyLimit);
      Store.state.dailyAvailable = computeDailyAvailable();
      renderProgressBars();
    });

    Store.subscribe('monthlyLimit', (val) => {
      _refreshLimitDisplays();
      _persist(Store.state.dailyLimit, Store.state.weeklyLimit, val);
      Store.state.dailyAvailable = computeDailyAvailable();
      renderProgressBars();
    });

    Store.subscribe('transactions', () => {
      Store.state.dailyAvailable = computeDailyAvailable();
      renderProgressBars();
    });

    Store.subscribe('rates', _updateConverterResult);

    // ── Converter widget ─────────────────────────────────────────────────

    // Init local state: from = main currency, to = USD (or RUB if main is USD)
    _converterFrom = Store.state.currency || 'RUB';
    _converterTo   = _converterFrom === 'USD' ? 'RUB' : 'USD';

    const fromLabel = document.getElementById('converter-from-label');
    const toLabel   = document.getElementById('converter-to-label');
    if (fromLabel) fromLabel.textContent = _CURRENCY_COMPACT[_converterFrom] || _converterFrom;
    if (toLabel)   toLabel.textContent   = _CURRENCY_COMPACT[_converterTo]   || _converterTo;

    const converterAmountBtn   = document.getElementById('converter-from-amount');
    const converterFromSelBtn  = document.getElementById('custom-converter-from-select');
    const converterToSelBtn    = document.getElementById('custom-converter-to-select');
    const converterSwapBtn     = document.getElementById('converter-swap');

    if (converterAmountBtn) {
      converterAmountBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        _openModal('converter');
      });
    }

    if (converterFromSelBtn) {
      converterFromSelBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        _openCurrencySheet('from');
      });
    }

    if (converterToSelBtn) {
      converterToSelBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        _openCurrencySheet('to');
      });
    }

    if (converterSwapBtn) {
      converterSwapBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const temp   = _converterFrom;
        _converterFrom = _converterTo;
        _converterTo   = temp;
        if (fromLabel) fromLabel.textContent = _CURRENCY_COMPACT[_converterFrom] || _converterFrom;
        if (toLabel)   toLabel.textContent   = _CURRENCY_COMPACT[_converterTo]   || _converterTo;
        _updateConverterResult();
        window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
      });
    }
  }

  return { init, computeDailyAvailable, renderProgressBars };
})();

window.Settings = Settings;
