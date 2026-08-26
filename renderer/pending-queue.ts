/**
 * Splitting a paused viewer's queue from the snapshot it is about to adopt.
 *
 * While paused, arriving lines pile up in a queue instead of the buffer. When
 * the viewer then reloads — a restart, a re-select of what it already shows —
 * the two overlap: main forwards a line through the subscription the viewer
 * ALREADY holds, and includes that same line in the snapshot it reads a moment
 * later. Flushing the queue afterwards would show it twice.
 *
 * Timestamps cannot draw the line, because a burst shares a millisecond. The
 * buffer's own sequence can: it only ever grows, so anything at or below what
 * the snapshot reached is already in it.
 */
export function queuedAfter<T extends { seq?: number | undefined }>(
  queued: readonly T[],
  watermark: (entry: T) => number,
): T[] {
  return queued.filter((entry) => (entry.seq ?? 0) > watermark(entry));
}
