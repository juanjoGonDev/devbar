/**
 * Index arithmetic for the log viewer's render window.
 *
 * Kept apart from the DOM because this is where the off-by-ones live: a window
 * that stops one short of the end never lets you reach the newest line, and one
 * that grows without dropping the far edge defeats the point of windowing at
 * all. All positions are indices into the filtered list, inclusive.
 */

export interface Win {
  start: number;
  end: number;
}

/** Empty is expressed as start > end, never as negative indices. */
const EMPTY: Win = { start: 0, end: -1 };

function clamp(win: Win, total: number): Win {
  if (total <= 0) return EMPTY;
  const end = Math.min(total - 1, win.end);
  const start = Math.max(0, Math.min(win.start, end + 1));
  return { start, end };
}

/** The tail of the list: what you want when a view opens or filters change. */
export function initialWindow(total: number, rows: number): Win {
  if (total <= 0) return EMPTY;
  return clamp({ start: total - rows, end: total - 1 }, total);
}

/** Centred on `pos`, for landing on a line after a jump. */
export function windowAround(pos: number, total: number, rows: number): Win {
  if (total <= 0) return EMPTY;
  const half = Math.floor(rows / 2);
  return clamp({ start: pos - half, end: pos + half }, total);
}

/**
 * Grow upward by `chunk`, dropping from the bottom once the window is longer
 * than `rows + chunk` — so scrolling up stays bounded instead of accumulating
 * the whole buffer in the DOM.
 */
export function extendTop(
  win: Win,
  total: number,
  chunk: number,
  rows: number,
): Win {
  if (win.start <= 0) return clamp(win, total);
  const start = Math.max(0, win.start - chunk);
  // Inclusive bounds: the last kept row is start + budget - 1.
  const end = Math.min(win.end, start + rows + chunk - 1);
  return clamp({ start, end }, total);
}

/** The mirror image: grow downward, dropping from the top. */
export function extendBottom(
  win: Win,
  total: number,
  chunk: number,
  rows: number,
): Win {
  if (win.end >= total - 1) return clamp(win, total);
  const end = Math.min(total - 1, win.end + chunk);
  const start = Math.max(win.start, end - rows - chunk + 1);
  return clamp({ start, end }, total);
}

/** Force a window inside a list's bounds, for use after the list shifts. */
export function clampWindow(start: number, end: number, total: number): Win {
  return clamp({ start, end }, total);
}

/** How many rows a window covers. */
export function windowSize(win: Win): number {
  return Math.max(0, win.end - win.start + 1);
}
