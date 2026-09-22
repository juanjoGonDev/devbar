export interface ComboboxOption {
  value: string;
  label: string;
  current?: boolean;
}
export interface ComboboxControl extends HTMLDivElement {
  setOptions(options: ComboboxOption[]): void;
  setLoading(loading: boolean): void;
  setValue(value: string | null): void;
}
interface ComboboxOptions {
  value: string | null;
  options: ComboboxOption[];
  placeholder?: string;
  onSelect?: (value: string) => unknown;
}
interface HostHooks {
  flushPendingRender?: () => void;
  scheduleTrayResize?: () => void;
  /** Natural height of the host's own content, independent of window size. */
  measureContentHeight?: () => number;
}
let openCount = 0;
let selectingAt = 0;
let hostHooks: HostHooks = {};
/** Distinguishes the ids of two comboboxes on the same page — `aria-controls`
 * and `aria-activedescendant` are id references, so they have to be unique. */
let comboboxCount = 0;
export function setComboboxHostHooks(hooks: HostHooks): void {
  hostHooks = hooks;
}

/**
 * Height the host window needs so an open dropdown fits: whichever is taller,
 * the host's own content or the bottom edge of the list.
 *
 * The floor MUST be a content measurement. Flooring on the window's current
 * height instead turns this into a ratchet — the host can then only ever grow,
 * and since the main process applies a few pixels of padding on top, every
 * single call inflates the window a little further. That is what made the tray
 * popover creep taller on each keystroke in the branch search and never come
 * back down while a dropdown with no matches stayed open.
 */
export function hostHeightFor(
  contentHeight: number,
  listBottom: number,
): number {
  return Math.max(contentHeight, Math.ceil(listBottom + 12));
}
export function isComboboxOpen(): boolean {
  return openCount > 0;
}
export function lastComboboxInteractionAt(): number {
  return selectingAt;
}

export function createCombobox({
  value,
  options,
  placeholder = '',
  onSelect,
}: ComboboxOptions): ComboboxControl {
  let currentValue = value;
  let currentOptions = options;
  let isLoading = false;
  let isOpen = false;
  let highlightIndex = -1;
  /**
   * What the user has typed since the dropdown opened — NOT `input.value`.
   *
   * The input carries the checked-out branch, which the widget writes there
   * itself. Filtering on it meant opening the picker on a group sitting on
   * `main` listed only `main`: every other branch was hidden behind a query
   * nobody had typed, and the control could not do the one thing it exists
   * for until the text was deleted by hand.
   */
  let query = '';
  const instanceId = `combobox-${(comboboxCount += 1)}`;
  const root = document.createElement('div') as ComboboxControl;
  root.className = 'combobox';
  root.style.cssText = 'position:relative; min-width:0;';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combobox-input branch-select';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText =
    'display:block;width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border-strong);border-radius:4px;background:var(--bg-card-strong);color:inherit;cursor:pointer';
  // Without these the widget is a plain text box to a screen reader: the
  // dropdown it controls, whether that dropdown is open, and which row the
  // arrow keys are on are all invisible. They carry no styling and no
  // behaviour of their own — `aria-activedescendant` only ever points at the
  // row that already has `.is-highlighted`.
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${instanceId}-list`);
  root.appendChild(input);
  const list = document.createElement('div');
  list.id = `${instanceId}-list`;
  list.className = 'combobox-list';
  list.setAttribute('role', 'listbox');
  list.style.position = 'fixed';
  list.style.display = 'none';
  document.body.appendChild(list);

  const labelFor = (selected: string | null): string =>
    currentOptions.find((option) => option.value === selected)?.label ?? '';
  const filteredOptions = (): ComboboxOption[] => {
    const q = query.trim().toLowerCase();
    return q
      ? currentOptions.filter((option) =>
          option.label.toLowerCase().includes(q),
        )
      : currentOptions;
  };
  /**
   * The options in the order they are DRAWN — checked-out branch first.
   *
   * The list and the keyboard handler must agree on this order. They did not:
   * the list hoisted the checked-out branch to the top while Enter indexed
   * into the unhoisted list, so with a branch checked out the highlight and
   * the selection pointed at different rows and arrow-down-then-Enter checked
   * out a branch the user had never highlighted.
   */
  const visibleOptions = (): ComboboxOption[] => {
    const raw = filteredOptions();
    const currentIndex = raw.findIndex(
      (option) => option.current || option.value === currentValue,
    );
    return currentIndex > 0
      ? [
          raw[currentIndex]!,
          ...raw.slice(0, currentIndex),
          ...raw.slice(currentIndex + 1),
        ]
      : raw;
  };
  function positionList(): void {
    const rect = input.getBoundingClientRect();
    const winW = window.innerWidth;
    const margin = 10;
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
    list.style.bottom = 'auto';
    list.style.top = `${rect.bottom + 6}px`;
    list.style.maxHeight = `${Math.max(180, Math.min(320, window.innerHeight - rect.bottom - margin * 2))}px`;
  }
  function requestHostHeight(): void {
    if (!isOpen || !window.api?.setTrayHeight) return;
    const rect = list.getBoundingClientRect();
    if (!Number.isFinite(rect.bottom) || rect.bottom <= 0) return;
    void window.api.setTrayHeight(
      hostHeightFor(hostHooks.measureContentHeight?.() ?? 0, rect.bottom),
    );
  }
  function setActiveDescendant(id: string | null): void {
    if (id) input.setAttribute('aria-activedescendant', id);
    else input.removeAttribute('aria-activedescendant');
  }
  function renderList(): void {
    list.innerHTML = '';
    const ordered = visibleOptions();
    if (isLoading && ordered.length === 0) {
      const item = document.createElement('div');
      item.className = 'combobox-item combobox-loading';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-disabled', 'true');
      item.textContent = 'Cargando…';
      list.appendChild(item);
      setActiveDescendant(null);
      return;
    }
    let activeId: string | null = null;
    ordered.forEach((option, index) => {
      const item = document.createElement('div');
      const highlighted = index === highlightIndex;
      const current = Boolean(option.current || option.value === currentValue);
      item.className = `combobox-item${highlighted ? ' is-highlighted' : ''}${current ? ' is-current' : ''}`;
      item.id = `${instanceId}-option-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(current));
      item.dataset.value = option.value;
      item.title = option.label;
      if (highlighted) activeId = item.id;
      if (current) {
        const check = document.createElement('span');
        check.className = 'combobox-check';
        check.textContent = '✓';
        item.appendChild(check);
      }
      const label = document.createElement('span');
      label.className = 'combobox-label';
      label.textContent = option.label;
      item.appendChild(label);
      item.addEventListener('mouseenter', () => {
        if (highlightIndex === index) return;
        list
          .querySelector('.combobox-item.is-highlighted')
          ?.classList.remove('is-highlighted');
        item.classList.add('is-highlighted');
        highlightIndex = index;
        setActiveDescendant(item.id);
      });
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selectOption(option.value, option.label);
      });
      list.appendChild(item);
      if (current && index === 0 && ordered.length > 1) {
        const sep = document.createElement('div');
        sep.className = 'combobox-separator';
        // Decorative: a bare <div> inside a listbox is neither an option nor
        // a group, so hide it rather than leave it for a reader to trip over.
        sep.setAttribute('aria-hidden', 'true');
        list.appendChild(sep);
      }
    });
    setActiveDescendant(activeId);
  }
  function openList(): void {
    if (isOpen) return;
    isOpen = true;
    openCount += 1;
    highlightIndex = -1;
    query = '';
    input.setAttribute('aria-expanded', 'true');
    positionList();
    renderList();
    list.style.display = 'block';
    requestAnimationFrame(requestHostHeight);
  }
  const flushPendingRender = (): void => hostHooks.flushPendingRender?.();
  function closeList(revert = true, deferFlush = false): void {
    if (!isOpen) return;
    isOpen = false;
    openCount = Math.max(0, openCount - 1);
    selectingAt = Date.now();
    query = '';
    list.style.display = 'none';
    input.setAttribute('aria-expanded', 'false');
    setActiveDescendant(null);
    if (revert) input.value = labelFor(currentValue);
    if (!deferFlush) flushPendingRender();
    hostHooks.scheduleTrayResize?.();
  }
  function selectOption(selected: string, label: string): void {
    currentValue = selected;
    input.value = label || labelFor(selected);
    selectingAt = Date.now();
    closeList(false, true);
    Promise.resolve(onSelect?.(selected)).finally(flushPendingRender);
  }
  input.addEventListener('focus', () => {
    input.select();
    openList();
  });
  input.addEventListener('input', () => {
    highlightIndex = -1;
    if (!isOpen) openList();
    query = input.value;
    renderList();
    requestAnimationFrame(requestHostHeight);
  });
  input.addEventListener('keydown', (event) => {
    const opts = visibleOptions();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isOpen) {
        openList();
        return;
      }
      highlightIndex = Math.min(highlightIndex + 1, opts.length - 1);
      renderList();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightIndex = Math.max(highlightIndex - 1, 0);
      renderList();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const opt = highlightIndex >= 0 ? opts[highlightIndex] : undefined;
      if (opt) selectOption(opt.value, opt.label);
      else closeList(true);
    } else if (event.key === 'Escape') {
      closeList(true);
      input.blur();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => closeList(true), 120));
  let lastTop = 0,
    lastLeft = 0,
    resizeToken = 0;
  window.addEventListener('resize', () => {
    if (!isOpen) return;
    cancelAnimationFrame(resizeToken);
    resizeToken = requestAnimationFrame(() => {
      const rect = input.getBoundingClientRect();
      if (rect.top === lastTop && rect.left === lastLeft) return;
      lastTop = rect.top;
      lastLeft = rect.left;
      positionList();
    });
  });
  /**
   * A programmatic re-render changes the list's height, so the host has to be
   * re-measured. Without this, branches finishing loading (or a result set
   * emptying) while the list is open leaves the tray at the previous list's
   * height — clipped, or padded with dead space — until the user types again.
   */
  function reflowIfOpen(): void {
    if (isOpen) requestAnimationFrame(requestHostHeight);
  }

  root.setOptions = (next) => {
    currentOptions = next;
    input.value = labelFor(currentValue);
    // The line above just replaced whatever was in the box, so whatever the
    // user had typed is gone: the filter must go with it, or the list and the
    // input would disagree about what is being searched for.
    query = '';
    if (isOpen) {
      highlightIndex = -1;
      renderList();
      reflowIfOpen();
    }
  };
  root.setLoading = (loading) => {
    isLoading = loading;
    if (isOpen) {
      renderList();
      reflowIfOpen();
    }
  };
  root.setValue = (next) => {
    currentValue = next;
    input.value = labelFor(next);
    query = '';
  };
  input.value = labelFor(currentValue);
  return root;
}
