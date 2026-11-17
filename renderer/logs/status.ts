/**
 * The footer's status line, and the queue of lines a manual pause holds back.
 *
 * The footer answers two questions — how many lines are selected, whether a
 * copy just succeeded — so they have to agree on who wrote last. How many
 * lines a pause is holding is the live button's to say (`live.ts`); the queue
 * sits here because a scope switch has to empty it in the same breath as it
 * clears the selection.
 */
import { createPendingLines } from '../log-view/pending.js';
import { buffer } from './buffer.js';
import { dispatchLive } from './live.js';
import { clearSelectionBtn, linesEl, statusEl } from './elements.js';
import type { LogEntry } from '../../src/domain-types.js';

/** Lines held back from the buffer while the viewer is paused. */
export const pendingQueue: LogEntry[] = [];

const pending = createPendingLines({
  buffer,
  pending: pendingQueue,
  dispatchLive,
});

/** Hold a line that arrived while paused (see `log-view/pending.ts`). */
export const queueWhilePaused = pending.queueWhilePaused;
/** Forget lines queued while paused, before a new snapshot is asked for. */
export const dropPendingQueue = pending.dropPendingQueue;
/** Keep only what a freshly adopted snapshot does not already contain. */
export const keepQueuedAfter = pending.keepQueuedAfter;

export function reportSelection(): void {
  const count = buffer.selected.size;
  clearSelectionBtn.hidden = count === 0;
  statusEl.textContent = count ? `${count} seleccionada(s)` : '';
}

/** Re-mark the drawn rows from the selection, which is keyed by entry. */
export function repaintSelection(): void {
  for (const node of Array.from(linesEl.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const index = Number(node.dataset.eidx);
    node.classList.toggle('selected', buffer.selected.has(index));
  }
  reportSelection();
}
