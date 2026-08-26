import { describe, expect, it } from 'vitest';
import { queuedAfter } from '../renderer/pending-queue.js';

/**
 * The overlap this guards: a paused viewer is fed by a subscription it already
 * holds, so a reload's snapshot and its queue can contain the same line. Only
 * the buffer's sequence separates them — timestamps do not, because a restart
 * emits its burst inside one millisecond.
 */

function line(seq: number, srcId = 'a'): { seq: number; srcId: string } {
  return { seq, srcId };
}

describe('queuedAfter', () => {
  it('drops what the snapshot already reached', () => {
    const kept = queuedAfter([line(8), line(9), line(10), line(11)], () => 9);
    expect(kept.map((entry) => entry.seq)).toEqual([10, 11]);
  });

  it('keeps nothing when the snapshot caught up with the queue', () => {
    expect(queuedAfter([line(1), line(2)], () => 5)).toEqual([]);
  });

  it('keeps everything emitted after main read the buffer', () => {
    const queue = [line(6), line(7)];
    expect(queuedAfter(queue, () => 5)).toEqual(queue);
  });

  it('drops a finished run, whose count the snapshot has passed', () => {
    // The count never resets on restart, so the previous run sits below it.
    const kept = queuedAfter([line(3), line(4), line(41)], () => 40);
    expect(kept.map((entry) => entry.seq)).toEqual([41]);
  });

  it('applies a per-source boundary in a merged view', () => {
    const seqs: Record<string, number> = { a: 10, b: 2 };
    const kept = queuedAfter(
      [line(9, 'a'), line(11, 'a'), line(3, 'b'), line(1, 'b')],
      (entry) => seqs[entry.srcId] ?? 0,
    );
    expect(kept.map((entry) => `${entry.srcId}${entry.seq}`)).toEqual([
      'a11',
      'b3',
    ]);
  });

  it('keeps a source the snapshot never mentioned', () => {
    // A service that started after the view opened has no watermark yet.
    const kept = queuedAfter([line(1, 'new')], () => 0);
    expect(kept).toHaveLength(1);
  });

  it('treats an unstamped entry as older than anything', () => {
    expect(queuedAfter([{ seq: undefined }], () => 0)).toEqual([]);
  });

  it('reconciles a whole load: some sources caught up, one brand new', () => {
    // The shape endLoad() faces after a merged snapshot lands: lines held for
    // one round trip, each carrying the source that produced it.
    const seqs: Record<string, number> = { back: 40, front: 12 };
    const held = [
      line(38, 'back'), // in the snapshot
      line(41, 'back'), // emitted after main read the buffer
      line(12, 'front'), // exactly where the snapshot ended
      line(13, 'front'),
      line(1, 'worker'), // a service the snapshot never saw
    ];
    const kept = queuedAfter(held, (entry) => seqs[entry.srcId] ?? 0);
    expect(kept.map((entry) => `${entry.srcId}${entry.seq}`)).toEqual([
      'back41',
      'front13',
      'worker1',
    ]);
  });

  it('leaves the queue it was given alone', () => {
    const queue = [line(1), line(9)];
    queuedAfter(queue, () => 5);
    expect(queue).toHaveLength(2);
  });
});
