/**
 * The logs window's rows: the row builder every log view shares
 * (`renderer/log-view/rows.ts`) bound to the window's own view, buffer and
 * stack blocks, its scope switcher and the footer's clock mode.
 *
 * The pane draws with its own instance of the same builder; this one is what
 * the footer's clock and anything else in the window that builds or restamps
 * a row reach for.
 */
import { createRowBuilder, stampText as stampIn } from '../log-view/rows.js';
import { rowPrefs } from './row-prefs.js';
import { buffer } from './buffer.js';
import { windowStacks } from './stack-fold.js';
import { nav, rowHooks, view } from './view.js';

/** A row's clock, in the mode the footer's «Hora» switch is on. */
export function stampText(ts: number): string {
  return stampIn(ts, rowPrefs.relativeTime);
}

/**
 * Build one row. Pure construction: it neither appends nor trims, so the
 * window layer can render any slice of the buffer, repeatedly.
 */
export const buildRow = createRowBuilder(
  { state: view, buffer, stacks: windowStacks, nav, prefs: rowPrefs },
  () => rowHooks.repaint(),
);
