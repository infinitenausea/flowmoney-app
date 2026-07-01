/**
 * FlowMoney — Swipe Gesture Handler for Timeline (Этап 5.2)
 *
 * Left swipe  → past threshold: pin item open (.swipe-opened-delete),
 *               revealing the red delete panel. A second, deliberate tap
 *               on that panel commits the delete; a tap elsewhere or a
 *               swipe back right closes it without deleting.
 * Right swipe → reveals a green duplicate panel that fades/scales in with
 *               the drag; past threshold on release: duplicate tx to today.
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
    let _dupEl   = null;   // .swipe-action-duplicate inside active item
    let _startX  = 0;
    let _startY  = 0;
    let _isH     = null;   // null = undecided, true = horizontal, false = vertical
    let _pid     = null;   // active pointerId

    // ── State for the "opened" (revealed delete panel) item ────────────────
    let _openedEl      = null; // .timeline-item currently pinned open
    let _openedContent = null;
    let _openedDel     = null;

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

      // Reveal duplicate panel proportionally as user drags right
      if (_dupEl) {
        const progress         = Math.min(1, Math.max(0, tx / MAX_RIGHT));
        _dupEl.style.opacity   = String(progress);
        _dupEl.style.transform = `translateX(${(1 - progress) * -40}%) scale(${0.85 + 0.15 * progress})`;
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
      if (_dupEl) {
        _dupEl.style.opacity   = '0';
        _dupEl.style.transform = 'translateX(-40%) scale(0.85)';
      }
    }

    function _clearState() {
      _item = null; _content = null; _delEl = null; _dupEl = null; _isH = null; _pid = null;
    }

    // Pin the item open: content stays shifted left, delete panel fully revealed.
    // Deletion itself now requires a second, deliberate tap on the panel.
    function _openForDelete(el, cnt, del) {
      el.classList.add('swipe-opened-delete');
      cnt.style.transition = 'transform 0.2s ease';
      cnt.style.transform  = `translateX(${-MAX_LEFT}px)`;
      if (del) {
        del.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        del.style.opacity    = '1';
        del.style.transform  = 'translateX(0%)';
      }
      _openedEl = el; _openedContent = cnt; _openedDel = del;
    }

    // Close the pinned-open item without deleting (tap elsewhere / swipe back).
    function _closeOpened() {
      if (!_openedEl) return;
      const el = _openedEl, cnt = _openedContent, del = _openedDel;

      cnt.style.transition = 'transform 0.2s ease';
      cnt.style.transform  = 'translateX(0)';
      if (del) {
        del.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        del.style.opacity    = '0';
        del.style.transform  = 'translateX(40%)';
      }
      el.classList.remove('swipe-opened-delete');

      _openedEl = null; _openedContent = null; _openedDel = null;
    }

    // Actually remove the transaction — only called from a deliberate tap
    // on the revealed delete panel of an already-opened item.
    function _commitDelete(el, cnt, txId) {
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('warning');

      el.classList.remove('swipe-opened-delete');
      if (_openedEl === el) { _openedEl = null; _openedContent = null; _openedDel = null; }

      cnt.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
      cnt.style.transform  = 'translateX(-110%)';

      const h = el.offsetHeight;
      el.style.overflow  = 'hidden';
      el.style.maxHeight = h + 'px';
      requestAnimationFrame(() => {
        el.style.transition   = 'max-height 0.28s ease 0.18s, opacity 0.28s ease 0.18s, margin 0.28s ease 0.18s';
        el.style.maxHeight    = '0';
        el.style.opacity      = '0';
        el.style.marginBottom = '0';
      });

      setTimeout(() => {
        el.remove();
        if (onDelete) onDelete(txId);
      }, 490);
    }

    // ── Pointer events ────────────────────────────────────────────────────

    containerEl.addEventListener('pointerdown', (e) => {
      // Let taps on the delete action button through as a native click
      // (handled below) instead of starting a new drag.
      if (e.target.closest('.swipe-action-delete')) return;

      const el = e.target.closest('.timeline-item');

      // Tapping anywhere outside the currently pinned-open item closes it.
      if (_openedEl && el !== _openedEl) {
        _closeOpened();
      } else if (_openedEl && el === _openedEl) {
        // Re-dragging the opened item: let the fresh gesture decide its fate.
        _openedEl = null; _openedContent = null; _openedDel = null;
      }

      if (!el) return;

      // If this item is already pinned open (delete panel revealed), the drag
      // should continue from its current offset instead of jumping back to 0 —
      // baking that offset into _startX means every later `dx = clientX - _startX`
      // naturally lands on `currentOffset + fingerMovement`.
      const baseX = el.classList.contains('swipe-opened-delete') ? -MAX_LEFT : 0;

      _item    = el;
      _content = el.querySelector('.timeline-item-content');
      _delEl   = el.querySelector('.swipe-action-delete');
      _dupEl   = el.querySelector('.swipe-action-duplicate');
      _startX  = e.clientX - baseX;
      _startY  = e.clientY;
      _isH     = null;
      _pid     = e.pointerId;
    });

    // Deliberate second tap on the revealed delete panel commits the deletion.
    containerEl.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.swipe-action-delete');
      if (!delBtn) return;

      const el = delBtn.closest('.timeline-item');
      if (!el || !el.classList.contains('swipe-opened-delete')) return;

      const cnt = el.querySelector('.timeline-item-content');
      _commitDelete(el, cnt, el.dataset.txId);
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
      const dup  = _dupEl;
      const txId = el.dataset.txId;

      // Snapshot references before clearing state
      _clearState();

      if (dx < -DELETE_THRESHOLD) {
        // ── REVEAL (pin open, wait for a deliberate confirm tap) ───────────
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('medium');
        _openForDelete(el, cnt, del);

      } else if (dx > DUP_THRESHOLD) {
        // ── DUPLICATE ────────────────────────────────────────────────────
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('medium');

        cnt.style.transition     = 'transform 0.3s cubic-bezier(0.4,0,0.2,1), background-color 0.15s ease';
        cnt.style.transform      = 'translateX(0)';
        cnt.style.backgroundColor = 'color-mix(in srgb, var(--success-color) 22%, transparent)';
        if (dup) {
          dup.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
          dup.style.opacity    = '0';
          dup.style.transform  = 'translateX(-40%) scale(0.85)';
        }

        setTimeout(() => {
          cnt.style.backgroundColor = '';
          if (onDuplicate) onDuplicate(txId);
        }, 320);

      } else {
        // ── SNAP BACK ────────────────────────────────────────────────────
        cnt.style.transition = 'transform 0.3s cubic-bezier(0.4,0,0.2,1)';
        cnt.style.transform  = 'translateX(0)';
        if (del) { del.style.opacity = '0'; del.style.transform = 'translateX(40%)'; }
        if (dup) { dup.style.opacity = '0'; dup.style.transform = 'translateX(-40%) scale(0.85)'; }
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
