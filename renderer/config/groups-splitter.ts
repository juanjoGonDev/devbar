/**
 * The draggable divider between the groups list and the group editor.
 *
 * Until the user drags it, the list is as wide as its longest group name, so
 * short names do not waste room and long ones are not cut off. Once dragged,
 * the chosen width sticks (localStorage) until a double-click on the divider
 * hands control back to the automatic width.
 */

import {
  attachResizeHandle,
  clampWidth,
  readStoredValue,
  writeStoredValue,
} from './resize-handle.js';

const MIN_WIDTH = 140;
const MAX_WIDTH = 320;
/** Matches the old fixed width, used until a row can be measured. */
const FALLBACK_WIDTH = 200;
const STORAGE_KEY = 'groups-list-width';

export function clampListWidth(width: number): number {
  return clampWidth(width, MIN_WIDTH, MAX_WIDTH);
}

/** The width that fits every row whole, given each row's full width. */
export function autoListWidth(rowWidths: readonly number[]): number {
  return clampListWidth(Math.max(MIN_WIDTH, ...rowWidths));
}

export interface GroupsSplitterElements {
  /** Carries `--groups-list-width`, which the left pane reads. */
  twoPane: HTMLElement;
  /** The left pane, whose gutter around the rows is measured. */
  pane: HTMLElement;
  /** The `role="separator"` divider. */
  handle: HTMLElement;
  /** `#groups-list`, holding the `.nav-card` rows. */
  listEl: HTMLElement;
  /** Injected by tests: jsdom lays nothing out. */
  measureText?: (nameEl: HTMLElement) => number;
}

export interface GroupsSplitter {
  /** Re-fits the automatic width after the rows changed. */
  refresh(): void;
}

function readStored(): number | null {
  const raw = readStoredValue(STORAGE_KEY);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? clampListWidth(value) : null;
}

function writeStored(width: number | null): void {
  writeStoredValue(STORAGE_KEY, width === null ? null : String(width));
}

/**
 * The name's natural width, set in the selected row's bold weight so the
 * selection never makes a name that just fit overflow. A detached probe,
 * because the name box itself is flex-stretched to the row.
 */
function probeText(nameEl: HTMLElement): number {
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap';
  probe.style.font = getComputedStyle(nameEl).font;
  probe.style.fontWeight = '600';
  probe.textContent = nameEl.textContent;
  document.body.appendChild(probe);
  const width = probe.offsetWidth;
  probe.remove();
  return width;
}

export function createGroupsSplitter(
  els: GroupsSplitterElements,
): GroupsSplitter {
  const measureText = els.measureText ?? probeText;
  let stored = readStored();
  let current = FALLBACK_WIDTH;

  function apply(width: number): void {
    current = clampListWidth(width);
    els.twoPane.style.setProperty('--groups-list-width', `${current}px`);
    els.handle.setAttribute('aria-valuenow', String(current));
  }

  /** Null while nothing is laid out: hidden rows all measure 0px. */
  function measured(): number | null {
    if (els.pane.offsetWidth === 0) return null;
    const widths: number[] = [];
    for (const card of els.listEl.querySelectorAll<HTMLElement>('.nav-card')) {
      const name = card.querySelector<HTMLElement>('.nav-name');
      if (!name) continue;
      // A folded list keeps the pane as a rail but lays no row out.
      if (card.offsetWidth === 0) return null;
      const chrome = card.offsetWidth - name.offsetWidth;
      const gutter = els.pane.clientWidth - card.offsetWidth;
      widths.push(measureText(name) + chrome + gutter);
    }
    return autoListWidth(widths);
  }

  function refresh(): void {
    if (stored !== null) return;
    const auto = measured();
    if (auto !== null) apply(auto);
  }

  function choose(width: number): void {
    apply(width);
    stored = current;
    writeStored(stored);
  }

  attachResizeHandle({
    handle: els.handle,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    current: () => current,
    preview: apply,
    commit: choose,
    onDragStart: () => els.twoPane.classList.add('is-resizing'),
    onDragEnd: () => els.twoPane.classList.remove('is-resizing'),
  });

  els.handle.addEventListener('dblclick', () => {
    stored = null;
    writeStored(null);
    refresh();
  });

  // The groups section starts hidden, so the first measurement usually has
  // nothing laid out to read. Re-fit once it gets a size — on the next frame,
  // because resizing the observed pane inside the callback is exactly what
  // raises "ResizeObserver loop completed with undelivered notifications".
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(() => requestAnimationFrame(refresh)).observe(els.pane);

  apply(stored ?? measured() ?? FALLBACK_WIDTH);
  return { refresh };
}
