/**
 * Picking lines out of the log, and getting them onto the clipboard.
 *
 * The selection itself is keyed by entry (see `buffer.ts`) so trimming the
 * buffer or re-filtering can never leave it pointing at rows that are gone;
 * this module is the part you touch — clicks, shift/ctrl ranges, ⌘A, ⌘C, Esc.
 */
import { closestElement } from '../dom.js';
import { applySelection, selectModeFor } from '../line-selection.js';
import {
  buffer,
  commitSelection,
  entriesToText,
  selectionAsPositions,
} from './buffer.js';
import { repaintSelection, reportSelection } from './status.js';
import { updateScrollButton } from './pane.js';
import { copyBtn, filterEl, linesEl, mainEl, statusEl } from './elements.js';

function clearSelection(): void {
  buffer.selected.clear();
  buffer.anchorEntry = null;
  repaintSelection();
  updateScrollButton(); // following may resume now
}

function selectAllVisible(): void {
  buffer.selected.clear();
  for (const index of buffer.visible) buffer.selected.add(index);
  buffer.anchorEntry = buffer.visible[0] ?? null;
  repaintSelection();
}

async function copyEntries(indices: readonly number[]): Promise<void> {
  try {
    await navigator.clipboard.writeText(entriesToText(indices));
    statusEl.textContent = `Copiado ✓ (${indices.length})`;
    setTimeout(reportSelection, 1500);
  } catch (err) {
    statusEl.textContent = 'Error al copiar';
  }
}

// Shift-click would otherwise extend the browser's text selection instead.
linesEl.addEventListener('mousedown', (ev) => {
  if (ev.shiftKey) ev.preventDefault();
});

linesEl.addEventListener('click', (ev) => {
  // A drag that selected text is a text selection, not a row click.
  if (!window.getSelection()?.isCollapsed) return;
  const row = closestElement(ev.target, '.line');
  if (!row) return;
  const entryIndex = Number(row.dataset.eidx);
  const pos = buffer.visible.indexOf(entryIndex);
  if (pos < 0) return;
  commitSelection(
    applySelection(selectionAsPositions(), pos, selectModeFor(ev)),
  );
  repaintSelection();
});

// Clicking the empty space under the last line drops the selection.
mainEl.addEventListener('click', (ev) => {
  if (!closestElement(ev.target, '.line')) clearSelection();
});

// With a selection the button copies just that; with none, everything the
// filter leaves — the whole filtered buffer, not merely the drawn window.
copyBtn.addEventListener('click', () => {
  const picked = [...buffer.selected].sort((a, b) => a - b);
  void copyEntries(picked.length ? picked : buffer.visible);
});

document.addEventListener('keydown', (e) => {
  const accel = e.metaKey || e.ctrlKey;
  if (accel && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    filterEl.focus();
    filterEl.select();
    return;
  }
  // Leave the shortcuts alone while typing in the filter or the search box.
  if (document.activeElement instanceof HTMLInputElement) return;
  if (accel && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    selectAllVisible();
    return;
  }
  if (accel && (e.key === 'c' || e.key === 'C')) {
    // A real text selection wins — let the browser copy exactly that.
    if (!window.getSelection()?.isCollapsed) return;
    if (!buffer.selected.size) return;
    e.preventDefault();
    void copyEntries([...buffer.selected].sort((a, b) => a - b));
    return;
  }
  if (e.key === 'Escape') clearSelection();
});
