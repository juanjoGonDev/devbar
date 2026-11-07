/**
 * The right half of the footer: «Ajustar líneas» and «Hora: absoluta/relativa».
 *
 * Wrapping is pure CSS (a class on the list), so switching it costs no
 * rebuild. Relative times go stale as the clock moves, so a ticker rewrites
 * the drawn timestamps every few seconds — text only, never the rows: a
 * rebuild would drop hover, focus and the reader's place, and there are only
 * as many stamps as rows in the window.
 */
import { setRelativeTime, setWrap, rowPrefs } from './row-prefs.js';
import { stampText } from './rows.js';
import { buffer } from './buffer.js';
import {
  linesEl,
  setText,
  timeModeBtn,
  timeModeValueEl,
  wrapLinesEl,
} from './elements.js';

/** How often a relative clock is brought up to date. */
const TICK_MS = 5_000;

/** Rewrite every drawn timestamp in the current mode. */
function restamp(): void {
  for (const row of Array.from(linesEl.children)) {
    const stamp = row.firstElementChild;
    if (!(row instanceof HTMLElement) || !(stamp instanceof HTMLElement))
      continue;
    // A folded stack's summary row draws no clock of its own.
    if (!stamp.classList.contains('ts') || row.classList.contains('stack-fold'))
      continue;
    const entry = buffer.entries[Number(row.dataset.eidx)];
    if (entry) setText(stamp, stampText(entry.ts));
  }
}

function paintWrap(): void {
  wrapLinesEl.checked = rowPrefs.wrap;
  linesEl.classList.toggle('nowrap', !rowPrefs.wrap);
}

function paintTimeMode(): void {
  const relative = rowPrefs.relativeTime;
  setText(timeModeValueEl, relative ? 'relativa' : 'absoluta');
  timeModeBtn.setAttribute('aria-pressed', String(relative));
}

wrapLinesEl.addEventListener('change', () => {
  setWrap(wrapLinesEl.checked);
  paintWrap();
});

timeModeBtn.addEventListener('click', () => {
  setRelativeTime(!rowPrefs.relativeTime);
  paintTimeMode();
  restamp();
});

setInterval(() => {
  if (rowPrefs.relativeTime) restamp();
}, TICK_MS);

paintWrap();
paintTimeMode();
