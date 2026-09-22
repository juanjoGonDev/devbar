/**
 * The footer line, and the queue that feeds it while the viewer is paused.
 *
 * One strip of text answers three different questions — how many lines are
 * selected, how many arrived while paused, whether a copy just succeeded — so
 * they have to agree on who wrote last. Keeping them together is what makes
 * "clear the selection" fall back to the paused badge instead of to nothing.
 */
import { queuedAfter } from '../pending-queue.js';
import { buffer } from './buffer.js';
import { copyBtn, linesEl, pausedEl, statusEl } from './elements.js';
import type { LogEntry } from '../../src/domain-types.js';

/** Lines held back from the buffer while the viewer is paused. */
export const pendingQueue: LogEntry[] = [];

/** The paused badge, or nothing when the viewer is live. */
function showPausedCount(): void {
  if (!pausedEl.checked) {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = pendingQueue.length
    ? `Pausado (+${pendingQueue.length})`
    : 'Pausado';
}

/** Hold a line that arrived while paused, and say so. */
export function queueWhilePaused(entry: LogEntry): void {
  pendingQueue.push(entry);
  statusEl.textContent = `Pausado (+${pendingQueue.length})`;
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
  showPausedCount();
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
  showPausedCount();
}

export function reportSelection(): void {
  const count = buffer.selected.size;
  copyBtn.title = count ? `Copiar ${count} línea(s) seleccionada(s)` : 'Copiar';
  if (count) statusEl.textContent = `${count} seleccionada(s)`;
  else if (pausedEl.checked) statusEl.textContent = 'Pausado';
  else statusEl.textContent = '';
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
