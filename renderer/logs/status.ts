/**
 * The footer's status line, and the queue of lines a manual pause holds back.
 *
 * The footer answers two questions — how many lines are selected, whether a
 * copy just succeeded — so they have to agree on who wrote last. How many
 * lines a pause is holding is the live button's to say (`live.ts`); the queue
 * sits here because a scope switch has to empty it in the same breath as it
 * clears the selection.
 */
import { queuedAfter } from '../pending-queue.js';
import { buffer } from './buffer.js';
import { dispatchLive } from './live.js';
import { clearSelectionBtn, linesEl, statusEl } from './elements.js';
import type { LogEntry } from '../../src/domain-types.js';

/** Lines held back from the buffer while the viewer is paused. */
export const pendingQueue: LogEntry[] = [];

/** Hold a line that arrived while paused, and count it on the live button. */
export function queueWhilePaused(entry: LogEntry): void {
  pendingQueue.push(entry);
  dispatchLive({ type: 'arrived', count: 1 });
}

/**
 * Forget lines queued while paused. They describe the buffer we are about to
 * replace, so they go BEFORE we ask main for the new one — never after: main
 * snapshots and resubscribes in the same tick, so a line is in one or the
 * other and never both. Dropping the queue once the snapshot lands would throw
 * away everything that arrived in between.
 */
export function dropPendingQueue(): void {
  pendingQueue.length = 0;
  dispatchLive({ type: 'reset' });
}

/**
 * Keep only what a freshly adopted snapshot does not already contain. The
 * subscription that fed the queue is the SAME one across a reload, so main's
 * snapshot-and-resubscribe-in-one-tick rule does not separate them here: only
 * the buffer's own sequence does.
 */
export function keepQueuedAfter(watermark: (entry: LogEntry) => number): void {
  const fresh = queuedAfter(pendingQueue, watermark);
  pendingQueue.length = 0;
  pendingQueue.push(...fresh);
}

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
