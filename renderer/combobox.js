'use strict';
/* exported createCombobox */

/**
 * createCombobox — a lightweight typeahead combobox for the DevBar popover.
 *
 * @param {object} opts
 * @param {string|null}  opts.value       - currently selected value (or null)
 * @param {Array}        opts.options     - [{ value, label, current? }]
 * @param {string}       opts.placeholder - input placeholder text
 * @param {function}     opts.onSelect    - called with (value) when user picks
 * @returns {HTMLElement} root element with .setOptions(opts) and .setLoading(bool)
 */
function createCombobox({ value, options, placeholder, onSelect }) {
  let currentValue = value;
  let currentOptions = options || [];
  let isLoading = false;
  let isOpen = false;
  let highlightIndex = -1;

  // ── Root container ────────────────────────────────────────────────────
  // Stays a flex-friendly child of its host row: starts at 110px but is
  // allowed to shrink down to its CSS-defined min-width when the row gets
  // crowded (e.g. while a pre-scripts pipeline is running and adds extra
  // controls on the right). Sizing rules live in styles.css (.combobox).
  const root = document.createElement('div');
  root.className = 'combobox';
  root.style.cssText = 'position:relative; min-width:0;';

  // ── Input ─────────────────────────────────────────────────────────────
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combobox-input branch-select';
  input.placeholder = placeholder || '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText = [
    'display:block',
    'width:100%',
    'font-size:11px',
    'padding:2px 4px',
    'border:1px solid var(--border-strong)',
    'border-radius:4px',
    'background:var(--bg-card-strong)',
    'color:inherit',
    'cursor:pointer',
  ].join(';');

  root.appendChild(input);

  // ── Option list ───────────────────────────────────────────────────────
  const list = document.createElement('div');
  list.className = 'combobox-list';
  // Only state-y rules inline. The visual look is governed by styles.css.
  list.style.position = 'fixed';
  list.style.display = 'none';
  document.body.appendChild(list);

  // ── Helpers ───────────────────────────────────────────────────────────

  function labelFor(val) {
    const opt = currentOptions.find((o) => o.value === val);
    return opt ? opt.label : '';
  }

  function filteredOptions() {
    const q = input.value.trim().toLowerCase();
    if (!q) return currentOptions;
    return currentOptions.filter((o) => o.label.toLowerCase().includes(q));
  }

  function positionList() {
    const rect = input.getBoundingClientRect();
    const winW = window.innerWidth;
    const margin = 10; // keep clear of the popover edges so the shadow shows

    // ── Horizontal anchor ───────────────────────────────────────────────
    // Drop from the input's left edge unless the resulting box would
    // overflow the popover window — in that case right-align to the
    // input so it grows leftwards (macOS menus near the screen edge).
    const preferredW = 320;
    const roomRight = winW - rect.left - margin;
    const roomLeft = rect.right - margin;

    list.style.width = 'auto';
    list.style.minWidth = `${Math.min(260, winW - margin * 2)}px`;

    if (roomRight >= preferredW || roomRight >= roomLeft) {
      list.style.left = `${Math.max(margin, rect.left)}px`;
      list.style.right = 'auto';
      list.style.maxWidth = `${roomRight}px`;
    } else {
      list.style.left = 'auto';
      list.style.right = `${Math.max(margin, winW - rect.right)}px`;
      list.style.maxWidth = `${roomLeft}px`;
    }

    // ── Vertical anchor ─────────────────────────────────────────────────
    // Always drop downward. The combobox asks the host window to grow
    // tall enough to fit the dropdown (see requestHostHeight below), so
    // anchoring above the input — which used to overlap the popover's
    // sticky header on small layouts — is no longer needed.
    list.style.bottom = 'auto';
    list.style.top = `${rect.bottom + 6}px`;
    list.style.maxHeight = `${Math.max(180, Math.min(320, window.innerHeight - rect.bottom - margin * 2))}px`;
  }

  /**
   * Ask the tray window to grow tall enough to fit the dropdown that
   * just opened (or was just resized). When the dropdown closes, the
   * tray runs its normal content-based measurement and shrinks back.
   */
  function requestHostHeight() {
    if (!isOpen) return;
    if (!window.api || !window.api.setTrayHeight) return;
    const listRect = list.getBoundingClientRect();
    if (!Number.isFinite(listRect.bottom) || listRect.bottom <= 0) return;
    const desired = Math.ceil(listRect.bottom + 12);
    window.api.setTrayHeight(desired);
  }

  function renderList() {
    list.innerHTML = '';
    const raw = filteredOptions();

    if (isLoading && raw.length === 0) {
      const item = document.createElement('div');
      item.className = 'combobox-item combobox-loading';
      item.textContent = 'Cargando…';
      list.appendChild(item);
      return;
    }

    // Order the list so the current branch sits at the top.
    const currentIdx = raw.findIndex(
      (o) => o.current || o.value === currentValue,
    );
    const opts =
      currentIdx > 0
        ? [
            raw[currentIdx],
            ...raw.slice(0, currentIdx),
            ...raw.slice(currentIdx + 1),
          ]
        : raw;

    opts.forEach((opt, idx) => {
      const item = document.createElement('div');
      const isHighlighted = idx === highlightIndex;
      const isCurrent = opt.current || opt.value === currentValue;
      item.className =
        'combobox-item' +
        (isHighlighted ? ' is-highlighted' : '') +
        (isCurrent ? ' is-current' : '');
      item.dataset.value = opt.value;
      item.title = opt.label; // tooltip with the full branch name

      if (isCurrent) {
        const check = document.createElement('span');
        check.className = 'combobox-check';
        check.textContent = '✓';
        item.appendChild(check);
      }

      const labelSpan = document.createElement('span');
      labelSpan.className = 'combobox-label';
      labelSpan.textContent = opt.label;
      item.appendChild(labelSpan);

      // CRITICAL: mouseenter MUST NOT trigger a full re-render of the list.
      //
      // Calling renderList() here destroys + recreates every item DOM node.
      // The cursor then "enters" the newly-created item under it, which
      // re-fires mouseenter, which re-renders, which… creates a tight
      // destroy/recreate loop. The user-visible symptom is that mousedown
      // never lands on the item — by the time the OS dispatches mousedown,
      // the node that received pointerdown has already been replaced, and
      // the event falls through to `.combobox-list`, so selectOption is
      // never called and the branch never switches.
      //
      // Fix: just toggle the `is-highlighted` CSS class on the previous
      // and new items. No DOM rebuild. No more event-loss races.
      item.addEventListener('mouseenter', () => {
        if (highlightIndex === idx) return;
        const prev = list.querySelector('.combobox-item.is-highlighted');
        if (prev && prev !== item) prev.classList.remove('is-highlighted');
        item.classList.add('is-highlighted');
        highlightIndex = idx;
      });

      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur input
        selectOption(opt.value, opt.label);
      });

      list.appendChild(item);

      // After the current branch (always shown first when present), add a
      // thin separator so it visually leads the rest of the list.
      if (isCurrent && idx === 0 && opts.length > 1) {
        const sep = document.createElement('div');
        sep.className = 'combobox-separator';
        list.appendChild(sep);
      }
    });
  }

  function openList() {
    if (isOpen) return;
    isOpen = true;
    highlightIndex = -1;
    positionList();
    renderList();
    list.style.display = 'block';
    // Defer one frame so the browser has computed the dropdown's
    // actual rendered height before we ask the host window to fit it.
    requestAnimationFrame(requestHostHeight);
  }

  function closeList(revert = true) {
    if (!isOpen) return;
    isOpen = false;
    list.style.display = 'none';
    if (revert) {
      input.value = labelFor(currentValue);
    }
    // Tell the tray window to shrink back to its natural content size
    // now that the dropdown no longer needs the extra real estate.
    if (typeof window.__scheduleTrayResize === 'function') {
      window.__scheduleTrayResize();
    }
  }

  function selectOption(val, label) {
    currentValue = val;
    input.value = label || labelFor(val);
    // Mark a recent combobox interaction so external click handlers
    // (e.g., the tray row's click-to-expand) can ignore the click event
    // that browsers synthesize when mouseup lands on the row below after
    // closeList() hides the dropdown under the cursor.
    window.__comboboxSelectingAt = Date.now();
    closeList(false);
    if (onSelect) onSelect(val);
  }

  // ── Input events ──────────────────────────────────────────────────────

  input.addEventListener('focus', () => {
    input.select();
    openList();
  });

  input.addEventListener('input', () => {
    highlightIndex = -1;
    if (!isOpen) openList();
    renderList();
    // Filter changed → list height changed → adjust host accordingly.
    requestAnimationFrame(requestHostHeight);
  });

  input.addEventListener('keydown', (e) => {
    const opts = filteredOptions();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        openList();
        return;
      }
      highlightIndex = Math.min(highlightIndex + 1, opts.length - 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightIndex = Math.max(highlightIndex - 1, 0);
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && opts[highlightIndex]) {
        const opt = opts[highlightIndex];
        selectOption(opt.value, opt.label);
      } else {
        closeList(true);
      }
    } else if (e.key === 'Escape') {
      closeList(true);
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so mousedown on an item fires before blur
    setTimeout(() => closeList(true), 120);
  });

  // Reposition only on actual window resizes — debounced and gated on
  // the input's rect actually changing. We deliberately do NOT listen
  // for scroll: position:fixed already keeps the dropdown anchored to
  // the viewport, and re-positioning on every scroll/popover re-render
  // tick produced visible jitter ("movimientos raros") whenever the
  // tray's dynamic-height pass fired beneath an open dropdown.
  let _lastAnchorTop = 0;
  let _lastAnchorLeft = 0;
  let _resizeTok = 0;
  function maybeReposition() {
    if (!isOpen) return;
    const rect = input.getBoundingClientRect();
    if (rect.top === _lastAnchorTop && rect.left === _lastAnchorLeft) return;
    _lastAnchorTop = rect.top;
    _lastAnchorLeft = rect.left;
    positionList();
  }
  window.addEventListener('resize', () => {
    if (!isOpen) return;
    cancelAnimationFrame(_resizeTok);
    _resizeTok = requestAnimationFrame(maybeReposition);
  });

  // ── Public API ────────────────────────────────────────────────────────

  root.setOptions = function (newOpts) {
    currentOptions = newOpts || [];
    // Update currentValue if the new options include it; otherwise reset label
    input.value = labelFor(currentValue);
    if (isOpen) {
      highlightIndex = -1;
      renderList();
    }
  };

  root.setLoading = function (bool) {
    isLoading = bool;
    if (isOpen) renderList();
  };

  root.setValue = function (val) {
    currentValue = val;
    input.value = labelFor(val);
  };

  // Set initial display value
  input.value = labelFor(currentValue);

  return root;
}
