import { describe, it, expect } from 'vitest';
import {
  isDue,
  isWorkflowScheduleDue,
  mostRecentOccurrence,
  nextWorkflowRun,
} from '../src/scheduler.js';
import type {
  Schedule,
  ScheduleRule,
  WorkflowSchedule,
} from '../src/domain-types.js';

// Local-time Date builder so tests read as wall-clock, matching how a user
// thinks about "run at 09:00". The scheduler works entirely in local time.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date =>
  new Date(y, mo, d, h, mi, 0, 0);
function expectOccurrence(value: Date | null): Date {
  expect(value).not.toBeNull();
  if (!value) throw new Error('Expected schedule occurrence');
  return value;
}

// 2026-01-05 is a Monday. Weekdays: Sun=0 … Sat=6.
const MON = at(2026, 0, 5, 9, 0);

describe('scheduler.mostRecentOccurrence', () => {
  it('returns today at the scheduled time once that time has passed (every day)', () => {
    const now = at(2026, 0, 5, 10, 0); // Mon 10:00
    const occ = expectOccurrence(
      mostRecentOccurrence({ time: '09:00', days: [] }, now),
    );
    expect(occ.getTime()).toBe(at(2026, 0, 5, 9, 0).getTime());
  });

  it('returns yesterday when today’s time has not arrived yet (every day)', () => {
    const now = at(2026, 0, 5, 8, 0); // Mon 08:00, before 09:00
    const occ = expectOccurrence(
      mostRecentOccurrence({ time: '09:00', days: [] }, now),
    );
    expect(occ.getTime()).toBe(at(2026, 0, 4, 9, 0).getTime()); // Sun
  });

  it('restricts to allowed weekdays — walks back to the last matching day', () => {
    // Only Mondays [1]; now is Wed 2026-01-07 12:00 → last occurrence is Mon 09:00.
    const now = at(2026, 0, 7, 12, 0);
    const occ = expectOccurrence(
      mostRecentOccurrence({ time: '09:00', days: [1] }, now),
    );
    expect(occ.getTime()).toBe(at(2026, 0, 5, 9, 0).getTime());
  });

  it('on the allowed day but before the time, returns the previous matching week', () => {
    // Only Mondays; now is Mon 08:00 → previous Monday (2025-12-29).
    const now = at(2026, 0, 5, 8, 0);
    const occ = expectOccurrence(
      mostRecentOccurrence({ time: '09:00', days: [1] }, now),
    );
    expect(occ.getTime()).toBe(at(2025, 11, 29, 9, 0).getTime());
  });
});

describe('scheduler.isDue', () => {
  const rule = (time: string, days: number[] = []): ScheduleRule => ({
    time,
    days,
  });
  const sched = (enabled: boolean, rules: ScheduleRule[]): Schedule => ({
    enabled,
    rules,
    interval: null,
  });

  it('is not due when the schedule is disabled', () => {
    expect(isDue(sched(false, [rule('09:00')]), null, MON)).toBe(false);
  });

  it('is not due when schedule is missing/undefined', () => {
    expect(isDue(undefined, null, MON)).toBe(false);
  });

  it('is not due when there are no rules', () => {
    expect(isDue(sched(true, []), null, MON)).toBe(false);
  });

  it('fires when the last run predates the most recent occurrence (catch-up)', () => {
    const lastRun = at(2026, 0, 4, 9, 5).toISOString(); // ran yesterday
    const now = at(2026, 0, 5, 9, 30); // woke at 09:30, missed 09:00
    expect(isDue(sched(true, [rule('09:00')]), lastRun, now)).toBe(true);
  });

  it('does not fire twice for the same occurrence', () => {
    const now = at(2026, 0, 5, 9, 30);
    const lastRun = at(2026, 0, 5, 9, 15).toISOString(); // already ran after 09:00
    expect(isDue(sched(true, [rule('09:00')]), lastRun, now)).toBe(false);
  });

  it('does not fire before the scheduled time has ever elapsed today with no prior miss', () => {
    const now = at(2026, 0, 5, 8, 0); // Mon 08:00
    const lastRun = at(2026, 0, 4, 9, 5).toISOString(); // ran at Sun 09:05
    // Most recent occurrence is Sun 09:00, which is < lastRun → not due.
    expect(isDue(sched(true, [rule('09:00')]), lastRun, now)).toBe(false);
  });

  it('with null lastRun, treats the current/past occurrence as due (seed decides in caller)', () => {
    expect(
      isDue(sched(true, [rule('09:00')]), null, at(2026, 0, 5, 10, 0)),
    ).toBe(true);
  });

  it('respects weekday filtering — not due on a non-listed day', () => {
    // Only weekends [0,6]; now is Mon 10:00. Most recent occ is Sun 09:00.
    const lastRun = at(2026, 0, 4, 9, 30).toISOString(); // ran Sun after occ
    expect(
      isDue(
        sched(true, [rule('09:00', [0, 6])]),
        lastRun,
        at(2026, 0, 5, 10, 0),
      ),
    ).toBe(false);
  });

  it('multiple rules: fires for a later slot the same day', () => {
    // rules 09:00 + 14:00 every day; ran 09:05; now 14:30 → 14:00 occ is due.
    const lastRun = at(2026, 0, 5, 9, 5).toISOString();
    const s = sched(true, [rule('09:00'), rule('14:00')]);
    expect(isDue(s, lastRun, at(2026, 0, 5, 14, 30))).toBe(true);
  });

  it('multiple rules: not due between slots', () => {
    // ran 09:05; now 12:00 → most recent occ is 09:00 < lastRun → not due.
    const lastRun = at(2026, 0, 5, 9, 5).toISOString();
    const s = sched(true, [rule('09:00'), rule('14:00')]);
    expect(isDue(s, lastRun, at(2026, 0, 5, 12, 0))).toBe(false);
  });

  describe('interval («Cada…») mode', () => {
    const every15: Schedule = {
      enabled: true,
      // Kept for «A una hora», ignored while the interval is set.
      rules: [rule('09:05')],
      interval: {
        every: 15,
        unit: 'minutes',
        window: { from: '09:00', to: '18:00' },
        days: [],
      },
    };

    it('is due on the first computed run after the last one', () => {
      const last = at(2026, 0, 5, 9, 0).toISOString();
      expect(isDue(every15, last, at(2026, 0, 5, 9, 14))).toBe(false);
      expect(isDue(every15, last, at(2026, 0, 5, 9, 15))).toBe(true);
    });

    it('ignores the kept rules', () => {
      const last = at(2026, 0, 5, 9, 0).toISOString();
      expect(isDue(every15, last, at(2026, 0, 5, 9, 6))).toBe(false);
    });

    it('is not due outside the window', () => {
      const last = at(2026, 0, 5, 18, 0).toISOString();
      expect(isDue(every15, last, at(2026, 0, 5, 23, 0))).toBe(false);
    });

    it('is not due while disabled or before the first run was seeded', () => {
      expect(isDue({ ...every15, enabled: false }, null, MON)).toBe(false);
      expect(isDue(every15, null, MON)).toBe(false);
    });
  });
});

describe('scheduler workflow schedules', () => {
  const daily9: WorkflowSchedule = {
    rules: [{ time: '09:00', days: [] }],
    interval: null,
  };
  const every30: WorkflowSchedule = {
    rules: [],
    interval: { every: 30, unit: 'minutes', window: null, days: [] },
  };

  it('is due once a rule occurrence passed since the last run', () => {
    const last = at(2026, 0, 5, 8, 0).toISOString();
    expect(isWorkflowScheduleDue(daily9, last, at(2026, 0, 5, 8, 59))).toBe(
      false,
    );
    expect(isWorkflowScheduleDue(daily9, last, at(2026, 0, 5, 9, 0))).toBe(
      true,
    );
  });

  it('is due once an anchored interval run passed since the last run', () => {
    // every 30 min anchored to midnight: 09:00, 09:30, … whatever the last run.
    const last = at(2026, 0, 5, 9, 10).toISOString();
    expect(isWorkflowScheduleDue(every30, last, at(2026, 0, 5, 9, 29))).toBe(
      false,
    );
    expect(isWorkflowScheduleDue(every30, last, at(2026, 0, 5, 9, 30))).toBe(
      true,
    );
  });

  it('counts hours as hours', () => {
    const hourly: WorkflowSchedule = {
      rules: [],
      interval: { every: 2, unit: 'hours', window: null, days: [] },
    };
    const last = at(2026, 0, 5, 8, 0).toISOString();
    expect(isWorkflowScheduleDue(hourly, last, at(2026, 0, 5, 9, 59))).toBe(
      false,
    );
    expect(isWorkflowScheduleDue(hourly, last, at(2026, 0, 5, 10, 0))).toBe(
      true,
    );
  });

  it('honours the window and the weekdays of an interval', () => {
    const office: WorkflowSchedule = {
      rules: [],
      interval: {
        every: 15,
        unit: 'minutes',
        window: { from: '09:00', to: '18:00' },
        days: [1, 2, 3, 4, 5],
      },
    };
    // Mon 18:00 ran; nothing more until Tue 09:00.
    const last = at(2026, 0, 5, 18, 0).toISOString();
    expect(isWorkflowScheduleDue(office, last, at(2026, 0, 6, 8, 59))).toBe(
      false,
    );
    expect(isWorkflowScheduleDue(office, last, at(2026, 0, 6, 9, 0))).toBe(
      true,
    );
    // Fri 18:00 ran; the weekend never fires.
    const friday = at(2026, 0, 9, 18, 0).toISOString();
    expect(isWorkflowScheduleDue(office, friday, at(2026, 0, 11, 23, 59))).toBe(
      false,
    );
  });

  it('is not due before the first run was seeded', () => {
    expect(isWorkflowScheduleDue(every30, null, MON)).toBe(false);
  });

  it('is never due with neither rules nor an interval', () => {
    expect(
      isWorkflowScheduleDue({ rules: [], interval: null }, null, MON),
    ).toBe(false);
  });

  it('finds the next rule occurrence, honouring weekdays', () => {
    const tuesdays: WorkflowSchedule = {
      rules: [{ time: '23:30', days: [2] }],
      interval: null,
    };
    // Mon 09:00 → Tue 23:30.
    expect(nextWorkflowRun(tuesdays, null, MON)?.getTime()).toBe(
      at(2026, 0, 6, 23, 30).getTime(),
    );
  });

  it('takes the next anchored interval run, ignoring the kept rules', () => {
    const both: WorkflowSchedule = {
      rules: [{ time: '09:10', days: [] }],
      interval: { every: 30, unit: 'minutes', window: null, days: [] },
    };
    const last = at(2026, 0, 5, 8, 50).toISOString();
    expect(nextWorkflowRun(both, last, MON)?.getTime()).toBe(
      at(2026, 0, 5, 9, 30).getTime(),
    );
  });

  it('has no next run with nothing scheduled', () => {
    expect(nextWorkflowRun({ rules: [], interval: null }, null, MON)).toBe(
      null,
    );
  });
});
