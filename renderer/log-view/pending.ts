/**
 * The lines a manual pause holds back from a view's buffer.
 *
 * How many a pause is holding is the live state's to say; the queue lives on
 * the view's context because a switch to another log has to empty it in the
 * same breath as it replaces the buffer.
 */
import { queuedAfter } from '../pending-queue.js';
import { rewrittenIndex } from '../logs/buffer.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { LogViewCtx } from './context.js';

export interface PendingLines {
  /**
   * Hold a line that arrived while paused, and count it on the live state —
   * unless it redraws a line already held, queued or on screen (a progress
   * bar): that one is rewritten in place on resume, so it is not news.
   */
  queueWhilePaused: (entry: LogEntry) => void;
  /**
   * Forget lines queued while paused. They describe the buffer we are about
   * to replace, so they go BEFORE we ask main for the new one — never after:
   * main snapshots and resubscribes in the same tick, so a line is in one or
   * the other and never both. Dropping the queue once the snapshot lands
   * would throw away everything that arrived in between.
   */
  dropPendingQueue: () => void;
  /**
   * Keep only what a freshly adopted snapshot does not already contain. The
   * subscription that fed the queue is the SAME one across a reload, so
   * main's snapshot-and-resubscribe-in-one-tick rule does not separate them
   * here: only the buffer's own sequence does.
   */
  keepQueuedAfter: (watermark: (entry: LogEntry) => number) => void;
}

export function createPendingLines(
  ctx: Pick<LogViewCtx, 'buffer' | 'pending' | 'dispatchLive'>,
): PendingLines {
  const { buffer, pending, dispatchLive } = ctx;
  return {
    queueWhilePaused(entry) {
      const redraw =
        rewrittenIndex(pending, entry) >= 0 ||
        rewrittenIndex(buffer.entries, entry) >= 0;
      pending.push(entry);
      if (!redraw) dispatchLive({ type: 'arrived', count: 1 });
    },
    dropPendingQueue() {
      pending.length = 0;
      dispatchLive({ type: 'reset' });
    },
    keepQueuedAfter(watermark) {
      const fresh = queuedAfter(pending, watermark);
      pending.length = 0;
      pending.push(...fresh);
    },
  };
}
