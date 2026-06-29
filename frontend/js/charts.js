/**
 * FlowMoney — Native SVG Donut Chart + Timeline Renderer (Этап 5.1)
 *
 * renderDonutChart(containerId, data)  — SVG donut via stroke-dasharray trick
 * renderTimeline(containerId, txs, categories) — grouped chronological list
 *
 * No external libraries. Hardware-accelerated transitions only.
 */

const DonutChart = (() => {
  // SVG geometry
  const R    = 35;              // ring radius
  const CX   = 50;
  const CY   = 50;
  const SW   = 18;              // stroke-width = ring thickness
  const CIRC = 2 * Math.PI * R; // ≈ 219.91

  let _selectedCatId  = null;
  let _lastData       = [];
  let _lastContId     = null;
  const _listeners    = new WeakSet(); // prevent duplicate listener on container

  // Escape HTML special characters to prevent XSS when injecting into innerHTML
  function _esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Donut chart ─────────────────────────────────────────────────────── */

  function renderDonutChart(containerId, data) {
    _lastContId = containerId;
    _lastData   = data || [];

    const container = document.getElementById(containerId);
    if (!container) return;

    const total = _lastData.reduce((s, d) => s + (d.total || 0), 0);

    if (!_lastData.length || total === 0) {
      container.innerHTML = '<p class="donut-empty">Нет расходов за этот месяц</p>';
      return;
    }

    let segsHTML   = '';
    let legendHTML = '';
    let offset     = 0;

    _lastData.forEach((item, i) => {
      // Enrich with category data from Store — makes the chart self-sufficient
      // regardless of whether the caller pre-enriched the data or not
      const category = (Store.state.categories || []).find(c => String(c.id) === String(item.category_id));
      const color    = category ? category.color : (item.color || `hsl(${(i * 53) % 360},65%,55%)`);
      const name     = category ? category.name  : (item.name  || 'Разное');

      const frac  = item.total / total;
      const len   = frac * CIRC;
      const isSel = _selectedCatId === item.category_id;
      const op    = _selectedCatId && !isSel ? 0.28 : 1;
      const sw    = isSel ? SW + 5 : SW;

      segsHTML += `<circle class="donut-segment" data-cat-id="${_esc(item.category_id)}"
        cx="${CX}" cy="${CY}" r="${R}" fill="none"
        stroke="${_esc(color)}" stroke-width="${sw}"
        stroke-dasharray="${len.toFixed(3)} ${(CIRC - len).toFixed(3)}"
        stroke-dashoffset="${(-offset).toFixed(3)}"
        transform="rotate(-90 ${CX} ${CY})"
        style="opacity:${op};transition:stroke-width .2s ease,opacity .2s ease;cursor:pointer"/>`;

      legendHTML += `
        <div class="donut-legend-item" data-cat-id="${_esc(item.category_id)}"
             style="opacity:${op};transition:opacity .2s ease;cursor:pointer">
          <span class="donut-legend-dot" style="background:${_esc(color)}"></span>
          <span class="donut-legend-name">${_esc(name)}</span>
          <span class="donut-legend-pct">${Math.round(frac * 100)}%</span>
        </div>`;

      offset += len;
    });

    // Center label: use enriched name from Store for the focused segment
    const focused = _selectedCatId ? _lastData.find(d => d.category_id === _selectedCatId) : null;
    const focusedCat = focused
      ? (Store.state.categories || []).find(c => c.id === focused.category_id)
      : null;
    const centerLabel = focusedCat
      ? focusedCat.name.slice(0, 12)
      : (focused ? (focused.name || '').slice(0, 12) : 'Месяц');
    const centerAmt   = focused ? focused.total : total;

    container.innerHTML = `
      <div class="donut-chart-wrap">
        <svg class="donut-svg" viewBox="0 0 100 100" role="img" aria-label="Расходы по категориям">
          <circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
            stroke="var(--secondary-bg-color)" stroke-width="${SW}"/>
          ${segsHTML}
          <text x="${CX}" y="${CY - 5}" text-anchor="middle" font-size="5.5"
            fill="var(--hint-color)" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${_esc(centerLabel)}</text>
          <text x="${CX}" y="${CY + 9}" text-anchor="middle" font-size="9.5" font-weight="700"
            fill="var(--text-color)" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${_fmtShort(centerAmt)}</text>
        </svg>
        <div class="donut-legend">${legendHTML}</div>
      </div>`;

    // Attach tap listener once per container (WeakSet prevents duplicates)
    if (!_listeners.has(container)) {
      _listeners.add(container);
      container.addEventListener('pointerdown', _onTap);
    }
  }

  function _onTap(e) {
    const target = e.target.closest('[data-cat-id]');
    const catId  = target ? target.dataset.catId : null;
    _selectedCatId = (_selectedCatId === catId) ? null : catId;
    Store.state.selectedAnalyticsCategory = _selectedCatId;
    window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
    renderDonutChart(_lastContId, _lastData);
  }

  function _fmtShort(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return Math.round(n).toString();
  }

  /* ── Timeline ─────────────────────────────────────────────────────────── */

  function renderTimeline(containerId, transactions, categories) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Build secondary catMap from the passed categories array as fallback
    const catMap = {};
    (categories || []).forEach(c => { catMap[c.id || c.category_id] = c; });

    const visible = (transactions || []).filter(tx => !tx.is_deleted);
    if (!visible.length) {
      container.innerHTML = '<p class="timeline-empty">Транзакций пока нет</p>';
      return;
    }

    // Group by calendar day (preserve insertion order = newest first)
    const groups = new Map();
    visible.forEach(tx => {
      const d   = new Date(tx.created_at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!groups.has(key)) groups.set(key, { date: d, items: [] });
      groups.get(key).items.push(tx);
    });

    const now      = new Date();
    const fragment = document.createDocumentFragment();

    groups.forEach(({ date, items }) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'timeline-day-group';

      const labelEl = document.createElement('div');
      labelEl.className = 'timeline-day-label';
      labelEl.textContent = _dayLabel(date, now);
      groupEl.appendChild(labelEl);

      items.forEach(tx => {
        // Primary lookup: Store.state.categories (authoritative, always fresh)
        // Fallback: catMap built from the passed categories argument
        const category     = (Store.state.categories || []).find(c => String(c.id) === String(tx.category_id));
        const cat          = category || catMap[tx.category_id] || {};
        const color        = cat.color || '#888888';
        const categoryIcon = cat.icon  || '💰';
        const categoryName = cat.name  || 'Неизвестная';
        const cur          = Store.state.currency || '₽';
        const time         = new Date(tx.created_at)
          .toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        // Root item element
        const itemEl = document.createElement('div');
        itemEl.className = 'timeline-item';
        itemEl.dataset.txId = tx.id;

        // Content row
        const contentEl = document.createElement('div');
        contentEl.className = 'timeline-item-content';

        // Category icon bubble — textContent is safe for emoji
        const iconEl = document.createElement('div');
        iconEl.className = 'timeline-item-icon';
        iconEl.style.cssText = `background:${color}22;color:${color}`;
        iconEl.textContent = categoryIcon;

        // Name + time column
        const infoEl = document.createElement('div');
        infoEl.className = 'timeline-item-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'timeline-item-name';
        nameEl.textContent = categoryName; // textContent prevents HTML injection

        const timeEl = document.createElement('div');
        timeEl.className = 'timeline-item-time';
        timeEl.textContent = time;

        infoEl.appendChild(nameEl);
        infoEl.appendChild(timeEl);

        // Amount
        const amountEl = document.createElement('div');
        amountEl.className = 'timeline-item-amount';
        amountEl.textContent = _fmtAmount(tx.amount, cur);

        contentEl.appendChild(iconEl);
        contentEl.appendChild(infoEl);
        contentEl.appendChild(amountEl);

        // Pending sync indicator
        if (!tx.synced) {
          const pendingEl = document.createElement('span');
          pendingEl.className = 'sync-pending';
          pendingEl.title = 'Ожидает синхронизации';
          contentEl.appendChild(pendingEl);
        }

        // Swipe-to-delete overlay — static SVG, innerHTML is safe here
        const swipeEl = document.createElement('div');
        swipeEl.className = 'swipe-action-delete';
        swipeEl.setAttribute('aria-hidden', 'true');
        swipeEl.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
          ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<polyline points="3 6 5 6 21 6"/>' +
          '<path d="M19 6l-1 14H6L5 6"/>' +
          '<path d="M10 11v6"/><path d="M14 11v6"/>' +
          '<path d="M9 6V4h6v2"/></svg>' +
          '<span>Удалить</span>';

        itemEl.appendChild(contentEl);
        itemEl.appendChild(swipeEl);
        groupEl.appendChild(itemEl);
      });

      fragment.appendChild(groupEl);
    });

    // Single DOM write — clears old content and appends new fragment
    container.innerHTML = '';
    container.appendChild(fragment);
  }

  function _dayLabel(date, now) {
    const d0   = new Date(now.getFullYear(),  now.getMonth(),  now.getDate());
    const d1   = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diff = Math.round((d0 - d1) / 86_400_000);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Вчера';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function _fmtAmount(amount, currency) {
    return Number(amount).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ' + (currency || '₽');
  }

  function resetFilter() {
    _selectedCatId = null;
    Store.state.selectedAnalyticsCategory = null;
  }

  return { renderDonutChart, renderTimeline, resetFilter };
})();

window.DonutChart = DonutChart;
