/**
 * A list pane the user can resize by dragging its divider, shared by the
 * settings' groups list and the logs window's sidebar.
 *
 * Until the user drags the divider, the pane is as wide as its longest row
 * name, so short names do not waste room and long ones are not cut off. Once
 * dragged, the chosen width sticks (localStorage) until a double-click on the
 * divider hands control back to the automatic width.
 */

import {
  attachResizeHandle,
  clampWidth,
  readStoredValue,
  writeStoredValue,
} from './config/resize-handle.js';

export interface WidthRange {
  min: number;
  max: number;
}

/** The width that fits every row whole, given each row's full width. */
export function fitWidth(
  rowWidths: readonly number[],
  { min, max }: WidthRange,
): number {
  return clampWidth(Math.max(min, ...rowWidths), min, max);
}

export interface ResizablePaneOptions extends WidthRange {
  /** Carries `cssVar`, and the `is-resizing` class while dragging. */
  host: HTMLElement;
  /** The pane, whose gutter around the rows is measured. */
  pane: HTMLElement;
  /** The `role="separator"` divider. */
  handle: HTMLElement;
  /** Holds the rows, however deeply nested. */
  listEl: HTMLElement;
  /** Used until a row can be measured. */
  fallback: number;
  storageKey: string;
  /** The custom property the pane's CSS width reads. */
  cssVar: string;
  rowSelector: string;
  /** The row's name box, which has to be stretched to fill the row. */
  nameSelector: string;
  /** The weight a name is measured in, when a row can make it heavier. */
  nameWeight?: string;
  /** Injected by tests: jsdom lays nothing out. */
  measureText?: (nameEl: HTMLElement) => number;
}

export interface ResizablePane {
  /** Re-fits the automatic width after the rows changed. */
  refresh(): void;
}

/**
 * The name's natural width, set in the font, spacing and case it is drawn
 * in. A detached probe, because the name box itself is stretched to the row.
 */
function probeText(nameEl: HTMLElement, weight?: string): number {
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap';
  const style = getComputedStyle(nameEl);
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.textTransform = style.textTransform;
  if (weight) probe.style.fontWeight = weight;
  probe.textContent = nameEl.textContent;
  document.body.appendChild(probe);
  const width = probe.offsetWidth;
  probe.remove();
  return width;
}

export function createResizablePane(
  options: ResizablePaneOptions,
): ResizablePane {
  const { host, pane, handle, listEl, min, max, storageKey } = options;
  const measureText =
    options.measureText ??
    ((nameEl: HTMLElement) => probeText(nameEl, options.nameWeight));
  const clamp = (width: number): number => clampWidth(width, min, max);

  function readStored(): number | null {
    const raw = readStoredValue(storageKey);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? clamp(value) : null;
  }

  function writeStored(width: number | null): void {
    writeStoredValue(storageKey, width === null ? null : String(width));
  }

  let stored = readStored();
  let current = options.fallback;

  function apply(width: number): void {
    current = clamp(width);
    host.style.setProperty(options.cssVar, `${current}px`);
    handle.setAttribute('aria-valuenow', String(current));
  }

  /**
   * Null while nothing is laid out: a hidden pane measures 0px, and so does a
   * folded one that keeps the pane as a rail but lays no row out. A single
   * hidden row (a closed group, a filtered one) is simply not on screen.
   */
  function measured(): number | null {
    if (pane.offsetWidth === 0) return null;
    const widths: number[] = [];
    let rows = 0;
    for (const row of listEl.querySelectorAll<HTMLElement>(
      options.rowSelector,
    )) {
      const name = row.querySelector<HTMLElement>(options.nameSelector);
      if (!name) continue;
      rows += 1;
      if (row.offsetWidth === 0) continue;
      const chrome = row.offsetWidth - name.offsetWidth;
      const gutter = pane.clientWidth - row.offsetWidth;
      widths.push(measureText(name) + chrome + gutter);
    }
    if (rows > 0 && widths.length === 0) return null;
    return fitWidth(widths, { min, max });
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
    handle,
    min,
    max,
    current: () => current,
    preview: apply,
    commit: choose,
    onDragStart: () => host.classList.add('is-resizing'),
    onDragEnd: () => host.classList.remove('is-resizing'),
  });

  handle.addEventListener('dblclick', () => {
    stored = null;
    writeStored(null);
    refresh();
  });

  // A pane often starts hidden, so the first measurement usually has nothing
  // laid out to read. Re-fit once it gets a size — on the next frame, because
  // resizing the observed pane inside the callback is exactly what raises
  // "ResizeObserver loop completed with undelivered notifications".
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(() => requestAnimationFrame(refresh)).observe(pane);

  apply(stored ?? measured() ?? options.fallback);
  return { refresh };
}
