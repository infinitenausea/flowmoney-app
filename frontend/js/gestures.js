/**
 * FlowMoney — Swipe Gesture Handler for Timeline (Этап 5.2)
 *
 * Left swipe  → reveal delete panel → at threshold: soft-delete tx
 * Right swipe → at threshold: duplicate tx to today
 *
 * Uses pointer-event delegation on a container element.
 * Calls e.preventDefault() once horizontal intent is confirmed so the
 * vertical scroll gesture is suppressed on iOS WebKit.
 */

const SwipeGesture = (() => {
  const DELETE_THRESHOLD = 100;  // px left to commit delete
  const DUP_THRESHOLD    = 60;   // px right to commit duplicate
  const MAX_LEFT         = 130;  // px beyond which resistance kicks in (left)
  const MAX_RIGHT        = 70;   // px beyond which resistance kicks in (right)
  const RESIST           = 0.22; // damping factor at edge

  function init(containerEl, { onDelete, onDuplicate } = {}) {
    if (!containerEl) return;

    // ── Per-gesture state ─────────────────────────────────────────────────
    let _item    = null;   // active .timeline-item element
    let _content = null;   // .timeline-item-content inside active item
    let _delEl   = null;   // .swipe-action-delete inside active item
    let _startX  = 0;
    let _startY  = 0;
    let _isH     = null;   // null = undecided, true = horizontal, false = vertical
    let _pid     = null;   // active pointerId

    // ── Helpers ───────────────────────────────────────────────────────────

    function _applyDrag(dx) {
      let tx = dx;
      if (dx < -MAX_LEFT) {
        tx = -MAX_LEFT + (dx + MAX_LEFT) * RESIST;
      } else if (dx > MAX_RIGHT) {
        tx = MAX_RIGHT + (dx - MAX_RIGHT) * RESIST;
      }

      _content.style.transition = 'none';
      _content.style.transform  = `translateX(${tx}px)`;

      // Reveal delete panel proportionally as user drags left
      if (_delEl) {
        const progress         = Math.min(1, Math.max(0, -tx / MAX_LEFT));
        _delEl.style.opacity   = String(progress);
        _delEl.style.transform = `translateX(${(1 - progress) * 40}%)`;
      }
    }

    function _snapBack() {
      if (!_content) return;
      _content.style.transition = 'transform 0.3s cubic-bezier(0.4,0,0.2,1)';
      _content.style.transform  = 'translateX(0)';
      if (_delEl) {
        _delEl.style.opacity   = '0';
        _delEl.style.transform = 'translateX(40%)';
      }
    }

    function _clearState() {
      _item = null; _content = null; _delEl = null; _isH = null; _pid = null;
    }

    // ── Pointer events ────────────────────────────────────────────────────

    containerEl.addEventListener('pointerdown', (e) => {
      // Let taps on the delete action button through as native clicks
      if (e.target.closest('.swipe-action-delete')) return;

      const el = e.target.closest('.timeline-item');
      if (!el) return;

      _item    = el;
      _content = el.querySelector('.timeline-item-content');
      _delEl   = el.querySelector('.swipe-action-delete');
      _startX  = e.clientX;
      _startY  = e.clientY;
      _isH     = null;
      _pid     = e.pointerId;
    });

    // passive: false is required so we can call preventDefault inside
    containerEl.addEventListener('pointermove', (e) => {
      if (!_item || e.pointerId !== _pid) return;

      const dx = e.clientX - _startX;
      const dy = e.clientY - _startY;

      // Decide horizontal vs vertical on first significant movement
      if (_isH === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        _isH = Math.abs(dx) > Math.abs(dy);
        if (_isH) {
          // Capture pointer so we receive events if finger exits the element
          try { _item.setPointerCapture(_pid); } catch (_) {}
        }
      }

      if (!_isH) return;

      // Stop the page from scrolling during a confirmed horizontal swipe
      e.preventDefault();
      _applyDrag(dx);
    }, { passive: false });

    containerEl.addEventListener('pointerup', (e) => {
      if (!_item || e.pointerId !== _pid) return;
      if (!_isH) { _clearState(); return; }

      const dx   = e.clientX - _startX;
      const el   = _item;
      const cnt  = _content;
      const del  = _delEl;
      const txId = el.dataset.txId;

      // Snapshot references before clearing state
      _clearState();

      if (dx < -DELETE_THRESHOLD) {
        // ── DELETE ────────────────────────────────────────────────────────
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('warning');

        // 1. Slide content fully off-screen to the left
        cnt.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
        cnt.style.transform  = 'translateX(-110%)';

        // 2. Collapse the item's height after slide completes
        const h = el.offsetHeight;
        el.style.overflow  = 'hidden';
        el.style.maxHeight = h + 'px';
        requestAnimationFrame(() => {
          el.style.transition  = 'max-height 0.28s ease 0.18s, opacity 0.28s ease 0.18s, margin 0.28s ease 0.18s';
          el.style.maxHeight   = '0';
          el.style.opacity     = '0';
          el.style.marginBottom = '0';
        });

        setTimeout(() => {
          el.remove();
          if (onDelete) onDelete(txId);
        }, 490);

      } else if (dx > DUP_THRESHOLD) {
        // ── DUPLICATE ────────────────────────────────────────────────────
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('medium');

        cnt.style.transition     = 'transform 0.3s cubic-bezier(0.4,0,0.2,1), background-color 0.15s ease';
        cnt.style.transform      = 'translateX(0)';
        cnt.style.backgroundColor = 'color-mix(in srgb, var(--success-color) 22%, transparent)';

        setTimeout(() => {
          cnt.style.backgroundColor = '';
          if (onDuplicate) onDuplicate(txId);
        }, 320);

      } else {
        // ── SNAP BACK ────────────────────────────────────────────────────
        cnt.style.transition = 'transform 0.3s cubic-bezier(0.4,0,0.2,1)';
        cnt.style.transform  = 'translateX(0)';
        if (del) { del.style.opacity = '0'; del.style.transform = 'translateX(40%)'; }
      }
    });

    containerEl.addEventListener('pointercancel', () => {
      _snapBack();
      _clearState();
    });
  }

  return { init };
})();

window.SwipeGesture = SwipeGesture;
