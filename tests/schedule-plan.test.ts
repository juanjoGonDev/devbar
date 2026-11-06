import { afterAll, describe, expect, it } from 'vitest';
import {
  describeSchedule,
  nextRuns,
  shortSchedule,
  type PlannableSchedule,
} from '../src/schedule-plan.js';
import type {
  ScheduleInterval,
  ScheduleRule,
  ScheduleWindow,
} from '../src/domain-types.js';

// The plan works in local wall-clock time, so the zone is pinned to one with
// DST (Europe/Madrid: 2026-03-29 02:00 → 03:00, 2026-10-25 03:00 → 02:00).
// It is set at load time because the tables below build their dates while
// the file is collected; Vitest runs each file in its own fork, and the zone
// is restored afterwards anyway.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Europe/Madrid';

const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date =>
  new Date(y, mo, d, h, mi, 0, 0);
const pad = (n: number): string => String(n).padStart(2, '0');
const fmt = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

const rule = (time: string, days: number[] = []): ScheduleRule => ({
  time,
  days,
});
const rules = (...list: ScheduleRule[]): PlannableSchedule => ({
  rules: list,
  interval: null,
});
const every = (
  n: number,
  unit: ScheduleInterval['unit'],
  window: ScheduleWindow | null = null,
  days: number[] = [],
): PlannableSchedule => ({
  rules: [],
  interval: { every: n, unit, window, days },
});
const WEEKDAYS = [1, 2, 3, 4, 5];
const NINE_TO_SIX = { from: '09:00', to: '18:00' };

describe('src/schedule-plan.ts', () => {
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  describe('nextRuns', () => {
    // 2026-01-05 is a Monday.
    it.each<[string, PlannableSchedule, Date, number, string[]]>([
      [
        'rules: the next weekday occurrences',
        rules(rule('08:00', WEEKDAYS)),
        at(2026, 0, 9, 9, 0),
        3,
        ['2026-01-12 08:00', '2026-01-13 08:00', '2026-01-14 08:00'],
      ],
      [
        'rules: several rules merged in time order',
        rules(rule('18:30'), rule('08:00')),
        at(2026, 0, 5, 12, 0),
        3,
        ['2026-01-05 18:30', '2026-01-06 08:00', '2026-01-06 18:30'],
      ],
      [
        'rules: strictly after `from`',
        rules(rule('08:00')),
        at(2026, 0, 5, 8, 0),
        1,
        ['2026-01-06 08:00'],
      ],
      [
        'rules: two rules at the same time count once',
        rules(rule('08:00'), rule('08:00', [2])),
        at(2026, 0, 5, 9, 0),
        2,
        ['2026-01-06 08:00', '2026-01-07 08:00'],
      ],
      ['rules: none → nothing', rules(), at(2026, 0, 5), 3, []],
      [
        'interval: inside a window (end included) on weekdays',
        every(15, 'minutes', NINE_TO_SIX, WEEKDAYS),
        at(2026, 0, 5, 17, 40),
        4,
        [
          '2026-01-05 17:45',
          '2026-01-05 18:00',
          '2026-01-06 09:00',
          '2026-01-06 09:15',
        ],
      ],
      [
        'interval: a Friday window skips the weekend',
        every(30, 'minutes', NINE_TO_SIX, WEEKDAYS),
        at(2026, 0, 9, 18, 0),
        1,
        ['2026-01-12 09:00'],
      ],
      [
        'interval: hours anchored to midnight',
        every(2, 'hours'),
        at(2026, 0, 5, 23, 30),
        3,
        ['2026-01-06 00:00', '2026-01-06 02:00', '2026-01-06 04:00'],
      ],
      [
        'interval: re-anchors at midnight when hours do not divide the day',
        every(7, 'hours'),
        at(2026, 0, 5, 20, 0),
        3,
        ['2026-01-05 21:00', '2026-01-06 00:00', '2026-01-06 07:00'],
      ],
      [
        'interval: a window crossing midnight belongs to the day it starts',
        every(1, 'hours', { from: '22:00', to: '02:00' }, [5]),
        at(2026, 0, 9, 21, 0),
        6,
        [
          '2026-01-09 22:00',
          '2026-01-09 23:00',
          '2026-01-10 00:00',
          '2026-01-10 01:00',
          '2026-01-10 02:00',
          '2026-01-16 22:00',
        ],
      ],
      [
        'interval: from inside a window that crossed midnight',
        every(1, 'hours', { from: '22:00', to: '02:00' }, [5]),
        at(2026, 0, 10, 0, 30),
        3,
        ['2026-01-10 01:00', '2026-01-10 02:00', '2026-01-16 22:00'],
      ],
      [
        'interval: `every` larger than the window fires at its start only',
        every(3, 'hours', { from: '09:00', to: '10:00' }),
        at(2026, 0, 5, 8, 0),
        2,
        ['2026-01-05 09:00', '2026-01-06 09:00'],
      ],
      [
        'interval: a window with from === to spans the whole day',
        every(12, 'hours', { from: '06:00', to: '06:00' }),
        at(2026, 0, 5, 7, 0),
        3,
        ['2026-01-05 18:00', '2026-01-06 06:00', '2026-01-06 18:00'],
      ],
      [
        'interval: the days filter',
        every(30, 'minutes', null, [0, 6]),
        at(2026, 0, 9, 23, 0),
        2,
        ['2026-01-10 00:00', '2026-01-10 00:30'],
      ],
      [
        'interval: days, at the window start, on a fixed day grid',
        every(2, 'days', NINE_TO_SIX),
        at(2026, 0, 5, 0, 0),
        3,
        ['2026-01-05 09:00', '2026-01-07 09:00', '2026-01-09 09:00'],
      ],
      [
        'interval: one day without a window fires at midnight',
        every(1, 'days'),
        at(2026, 0, 5, 10, 0),
        2,
        ['2026-01-06 00:00', '2026-01-07 00:00'],
      ],
      [
        'interval: days honour the weekday filter',
        every(1, 'days', { from: '08:00', to: '08:00' }, [1]),
        at(2026, 0, 5, 9, 0),
        2,
        ['2026-01-12 08:00', '2026-01-19 08:00'],
      ],
      [
        'interval: wins over rules kept for the «A una hora» mode',
        { rules: [rule('08:00')], interval: every(6, 'hours').interval },
        at(2026, 0, 5, 7, 0),
        2,
        ['2026-01-05 12:00', '2026-01-05 18:00'],
      ],
      [
        'DST spring forward: the missing hour folds into 03:00',
        every(30, 'minutes'),
        at(2026, 2, 29, 1, 0),
        4,
        [
          '2026-03-29 01:30',
          '2026-03-29 03:00',
          '2026-03-29 03:30',
          '2026-03-29 04:00',
        ],
      ],
      [
        'DST fall back: each wall-clock time once',
        every(30, 'minutes'),
        at(2026, 9, 25, 1, 0),
        4,
        [
          '2026-10-25 01:30',
          '2026-10-25 02:00',
          '2026-10-25 02:30',
          '2026-10-25 03:00',
        ],
      ],
      [
        'DST spring forward: a rule in the missing hour moves forward',
        rules(rule('02:30')),
        at(2026, 2, 28, 3, 0),
        2,
        ['2026-03-29 03:30', '2026-03-30 02:30'],
      ],
      [
        'DST: daily runs keep their wall-clock time across the change',
        every(1, 'days', { from: '09:00', to: '10:00' }),
        at(2026, 2, 28, 10, 0),
        2,
        ['2026-03-29 09:00', '2026-03-30 09:00'],
      ],
      ['count 0 → nothing', every(5, 'minutes'), at(2026, 0, 5), 0, []],
    ])('%s', (_label, schedule, from, count, expected) => {
      const runs = nextRuns(schedule, from, count);
      expect(runs.map(fmt)).toEqual(expected);
      for (let i = 1; i < runs.length; i++) {
        expect(
          (runs[i]?.getTime() ?? 0) > (runs[i - 1]?.getTime() ?? 0),
          'strictly increasing',
        ).toBe(true);
      }
    });

    it('finds a sparse run far ahead (every 365 days on one weekday)', () => {
      const runs = nextRuns(every(365, 'days', null, [3]), at(2026, 0, 5), 1);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.getDay()).toBe(3);
    });
  });

  describe('describeSchedule', () => {
    it.each<[PlannableSchedule, string]>([
      [rules(rule('08:00', WEEKDAYS)), 'A las 08:00 de lunes a viernes'],
      [
        rules(rule('18:30'), rule('08:00')),
        'Cada día a las 08:00 y a las 18:30',
      ],
      [
        rules(rule('08:00'), rule('12:00'), rule('18:30')),
        'Cada día a las 08:00, a las 12:00 y a las 18:30',
      ],
      [rules(rule('08:00', [0, 1, 2, 3, 4, 5, 6])), 'Cada día a las 08:00'],
      [rules(rule('10:00', [0, 6])), 'A las 10:00 los fines de semana'],
      [
        rules(rule('08:00', [1, 3, 5])),
        'A las 08:00 los lunes, miércoles y viernes',
      ],
      [rules(rule('08:00', [6])), 'A las 08:00 los sábados'],
      [rules(rule('08:00', [1, 2, 3])), 'A las 08:00 de lunes a miércoles'],
      [rules(rule('08:00', [5, 6, 0])), 'A las 08:00 de viernes a domingo'],
      [
        rules(rule('08:00', WEEKDAYS), rule('10:00', [0, 6])),
        'A las 08:00 de lunes a viernes; a las 10:00 los fines de semana',
      ],
      [rules(), 'Sin horario'],
      [
        every(15, 'minutes', NINE_TO_SIX, WEEKDAYS),
        'Cada 15 minutos, de 9:00 a 18:00, de lunes a viernes',
      ],
      [every(2, 'hours'), 'Cada 2 horas, todos los días'],
      [every(1, 'minutes'), 'Cada minuto, todos los días'],
      [
        every(1, 'hours', { from: '22:00', to: '02:30' }),
        'Cada hora, de 22:00 a 2:30, todos los días',
      ],
      [every(2, 'days', NINE_TO_SIX), 'Cada 2 días, a las 9:00'],
      [
        every(1, 'days', null, WEEKDAYS),
        'Cada día, a las 0:00, de lunes a viernes',
      ],
    ])('%j → %s', (schedule, expected) => {
      expect(describeSchedule(schedule)).toBe(expected);
    });
  });

  describe('shortSchedule', () => {
    it.each<[PlannableSchedule, string]>([
      [rules(rule('08:00', WEEKDAYS)), '08:00 · L–V'],
      [rules(rule('18:30'), rule('08:00')), '08:00, 18:30'],
      [rules(rule('08:00', WEEKDAYS), rule('10:00', [0, 6])), '08:00 · L–V +1'],
      [rules(rule('08:00', [1, 3, 5])), '08:00 · L, X, V'],
      [rules(rule('08:00', [1, 2, 3])), '08:00 · L–X'],
      [rules(), 'Sin horario'],
      [
        every(15, 'minutes', NINE_TO_SIX, WEEKDAYS),
        'cada 15 min · 9–18 h · L–V',
      ],
      [every(2, 'hours'), 'cada 2 h'],
      [every(1, 'minutes'), 'cada minuto'],
      [every(1, 'hours'), 'cada hora'],
      [
        every(30, 'minutes', { from: '09:30', to: '18:00' }, [0, 6]),
        'cada 30 min · 9:30–18 h · S–D',
      ],
      [every(3, 'days', { from: '08:00', to: '09:00' }), 'cada 3 días · 08:00'],
      [every(1, 'days'), 'cada día · 00:00'],
    ])('%j → %s', (schedule, expected) => {
      expect(shortSchedule(schedule)).toBe(expected);
    });
  });
});
