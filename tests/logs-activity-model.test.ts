import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_MAX_BARS,
  activityBars,
  activitySummary,
  addActivityLine,
  barTitle,
  bucketKeyOf,
  buildActivity,
  createActivity,
  pickStep,
  spanLabel,
  type ActivityLine,
} from '../renderer/logs/activity-model.js';

/**
 * `renderer/logs/activity-model.ts` is the arithmetic behind the strip of
 * bars over the log: which bucket a line falls in, how wide a bucket is, and
 * what each bar says. Nothing here touches the DOM.
 */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A local wall-clock instant, so the labels read the same in any timezone. */
function at(hours: number, minutes: number, seconds = 0): number {
  return new Date(2026, 9, 20, hours, minutes, seconds).getTime();
}

function line(
  ts: number,
  entryIndex: number,
  level: ActivityLine['level'] = null,
): ActivityLine {
  return { ts, level, entryIndex };
}

describe('renderer/logs/activity-model.ts', () => {
  describe('pickStep', () => {
    it('takes the smallest step that keeps the span within the bar budget', () => {
      expect(pickStep(30 * SECOND)).toBe(SECOND);
      expect(pickStep(4 * MINUTE)).toBe(5 * SECOND);
      expect(pickStep(35 * MINUTE)).toBe(MINUTE);
      expect(pickStep(3 * HOUR)).toBe(5 * MINUTE);
      expect(pickStep(2 * 24 * HOUR)).toBe(HOUR);
    });

    it('falls back to the widest step for a span no step can fit', () => {
      expect(pickStep(10_000 * 24 * HOUR)).toBe(24 * HOUR);
    });
  });

  describe('buckets', () => {
    it('counts lines per bucket and keeps the first entry of each', () => {
      const model = buildActivity([
        line(at(13, 44, 1), 0),
        line(at(13, 44, 50), 1),
        line(at(14, 20, 2), 2),
      ]);
      const bars = activityBars(model, 30);
      expect(model.step).toBe(60_000);
      expect([bars[0]?.count, bars.at(-1)?.count]).toEqual([2, 1]);
      expect([bars[0]?.firstEntry, bars.at(-1)?.firstEntry]).toEqual([0, 2]);
    });

    it('fills the gaps between busy buckets with empty bars', () => {
      const model = buildActivity([
        line(at(13, 0), 0),
        line(at(13, 3), 1),
        line(at(13, 30), 2),
      ]);
      const bars = activityBars(model, 30);
      expect(bars).toHaveLength(31);
      expect(bars[1]).toMatchObject({ count: 0, tone: 'empty', height: 0 });
    });

    it('colours a bar by the worst level it holds', () => {
      const model = buildActivity([
        line(at(13, 0, 0), 0),
        line(at(13, 0, 1), 1, 'warn'),
        line(at(13, 0, 2), 2, 'error'),
        line(at(13, 0, 3), 3, 'warn'),
        line(at(13, 0, 4), 4),
        line(at(13, 0, 5), 5),
      ]);
      expect(activityBars(model, 30).map((bar) => bar.tone)).toEqual([
        'normal',
        'warn',
        'error',
        'warn',
        'normal',
        'normal',
      ]);
    });

    it('scales heights by the square root so one burst does not flatten the rest', () => {
      const model = buildActivity([
        ...Array.from({ length: 100 }, (_, i) => line(at(13, 0, 0), i)),
        line(at(13, 0, 1), 100),
      ]);
      const [burst, single] = activityBars(model, 30);
      expect(burst?.height).toBe(30);
      expect(single?.height).toBe(3);
    });

    it('never draws a busy bucket shorter than a sliver', () => {
      const model = buildActivity([
        ...Array.from({ length: 10_000 }, (_, i) => line(at(13, 0, 0), i)),
        line(at(13, 0, 1), 10_000),
      ]);
      expect(activityBars(model, 30)[1]?.height).toBe(2);
    });

    it('skips lines without a usable clock', () => {
      const model = buildActivity([
        line(Number.NaN, 0),
        line(at(13, 0, 0), 1),
        line(at(13, 0, 1), 2),
      ]);
      expect(activityBars(model, 30).map((bar) => bar.count)).toEqual([1, 1]);
    });
  });

  describe('streaming', () => {
    it('widens its buckets once the span outgrows the bar budget', () => {
      const model = createActivity();
      for (let i = 0; i <= ACTIVITY_MAX_BARS; i += 1)
        addActivityLine(model, line(at(13, 0, i), i));
      expect(model.step).toBe(5 * SECOND);
      const bars = activityBars(model, 30);
      expect(bars.length).toBeLessThanOrEqual(ACTIVITY_MAX_BARS);
      expect(bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(61);
      expect(bars[0]?.firstEntry).toBe(0);
    });

    it('ends up where a full rebuild of the same lines would', () => {
      const lines = Array.from({ length: 2_000 }, (_, i) =>
        line(at(9, 0) + i * 7_919, i, i % 97 === 0 ? 'error' : null),
      );
      const streamed = createActivity();
      for (const each of lines) addActivityLine(streamed, each);
      const rebuilt = buildActivity(lines);
      expect(streamed.step).toBe(rebuilt.step);
      expect(activityBars(streamed, 30)).toEqual(activityBars(rebuilt, 30));
    });
  });

  describe('labels', () => {
    it('describes a bucket by its range, lines and problems', () => {
      const model = buildActivity([
        ...Array.from({ length: 118 }, (_, i) => line(at(13, 44, 5), i)),
        line(at(13, 44, 6), 118, 'error'),
        line(at(13, 44, 7), 119, 'error'),
        line(at(14, 20), 120, 'warn'),
        line(at(14, 20, 1), 121),
      ]);
      const [first] = activityBars(model, 30);
      expect(first && barTitle(first, model.step)).toBe(
        '13:44–13:45 · 120 líneas · 2 errores',
      );
      const last = activityBars(model, 30).at(-1);
      expect(last && barTitle(last, model.step)).toBe(
        '14:20–14:21 · 2 líneas · 1 aviso',
      );
    });

    it('shows seconds while buckets are shorter than a minute', () => {
      const model = buildActivity([
        line(at(13, 44, 5), 0),
        line(at(13, 44, 9), 1),
      ]);
      const [first] = activityBars(model, 30);
      expect(first && barTitle(first, model.step)).toBe(
        '13:44:05–13:44:06 · 1 línea',
      );
    });

    it('names the span the bars cover', () => {
      const minutes = buildActivity([line(at(13, 10), 0), line(at(13, 44), 1)]);
      expect(spanLabel(minutes)).toBe('últimos 35 min');
      const seconds = buildActivity([
        line(at(13, 0, 0), 0),
        line(at(13, 0, 39), 1),
      ]);
      expect(spanLabel(seconds)).toBe('últimos 40 s');
      const hours = buildActivity([line(at(1, 0), 0), line(at(12, 45), 1)]);
      expect(spanLabel(hours)).toBe('últimas 12 h');
    });

    it('sums the strip up for a screen reader', () => {
      const model = buildActivity([
        line(at(13, 10), 0),
        line(at(13, 20), 1, 'error'),
        line(at(13, 44), 2),
      ]);
      expect(activitySummary(model)).toBe(
        'Actividad: 3 líneas, últimos 35 min · 1 error',
      );
    });
  });

  describe('bucketKeyOf', () => {
    it('places a line in the bucket that contains its clock', () => {
      const model = buildActivity([line(at(13, 0), 0), line(at(13, 30), 1)]);
      expect(bucketKeyOf(model, at(13, 0, 59))).toBe(
        bucketKeyOf(model, at(13, 0)),
      );
      expect(bucketKeyOf(model, at(13, 1))).toBe(
        bucketKeyOf(model, at(13, 0)) + 1,
      );
    });
  });

  describe('performance', () => {
    it('buckets 50 000 lines, and streams them, in well under a frame budget each', () => {
      const lines = Array.from({ length: 50_000 }, (_, i) =>
        line(at(8, 0) + i * 250, i, i % 500 === 0 ? 'warn' : null),
      );
      const started = performance.now();
      const model = buildActivity(lines);
      activityBars(model, 30);
      const rebuild = performance.now() - started;

      const streamed = createActivity();
      const streamStarted = performance.now();
      for (const each of lines) addActivityLine(streamed, each);
      const stream = performance.now() - streamStarted;

      expect(rebuild, `rebuild took ${rebuild} ms`).toBeLessThan(100);
      expect(stream, `streaming took ${stream} ms`).toBeLessThan(100);
      expect(activityBars(streamed, 30)).toEqual(activityBars(model, 30));
    });
  });
});
