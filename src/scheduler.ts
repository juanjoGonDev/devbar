import type {
  Schedule,
  ScheduleInterval,
  ScheduleRule,
  WorkflowSchedule,
} from './domain-types.js';

function ruleTime(rule: ScheduleRule): [number, number] {
  const [hour = 0, minute = 0] = rule.time.split(':').map(Number);
  return [hour, minute];
}

export function mostRecentOccurrence(
  rule: ScheduleRule,
  now: Date,
): Date | null {
  const [hour, minute] = ruleTime(rule);
  const days = Array.isArray(rule.days) ? rule.days : [];
  for (let back = 0; back < 8; back++) {
    const date = new Date(now);
    date.setDate(date.getDate() - back);
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() > now.getTime()) continue;
    if (days.length === 0 || days.includes(date.getDay())) return date;
  }
  return null;
}

/** The first occurrence of `rule` strictly after `now`. */
function nextOccurrence(rule: ScheduleRule, now: Date): Date | null {
  const [hour, minute] = ruleTime(rule);
  const days = Array.isArray(rule.days) ? rule.days : [];
  for (let ahead = 0; ahead < 8; ahead++) {
    const date = new Date(now);
    date.setDate(date.getDate() + ahead);
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now.getTime()) continue;
    if (days.length === 0 || days.includes(date.getDay())) return date;
  }
  return null;
}

export function isDue(
  schedule: Schedule | null | undefined,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  if (!schedule?.enabled) return false;
  let best: Date | null = null;
  for (const rule of schedule.rules) {
    const occurrence = mostRecentOccurrence(rule, now);
    if (occurrence && (!best || occurrence.getTime() > best.getTime()))
      best = occurrence;
  }
  if (!best) return false;
  if (!lastRun) return true;
  return new Date(lastRun).getTime() < best.getTime();
}

function intervalMs(interval: ScheduleInterval): number {
  return interval.every * (interval.unit === 'hours' ? 3_600_000 : 60_000);
}

/**
 * A workflow's schedule: due when one of its weekday rules occurred since the
 * last run (exactly `isDue`), or when its interval has elapsed since then.
 * Whether the schedule is armed is the workflow's `enabled`, decided by the
 * caller.
 */
export function isWorkflowScheduleDue(
  schedule: WorkflowSchedule,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  if (isDue({ enabled: true, rules: schedule.rules }, lastRun, now))
    return true;
  if (!schedule.interval || !lastRun) return false;
  return (
    now.getTime() - new Date(lastRun).getTime() >= intervalMs(schedule.interval)
  );
}

/**
 * When the schedule fires next, after `now`: the earliest upcoming rule
 * occurrence or the end of the running interval (counted from the last run,
 * or from `now` when it never ran). Null when nothing is scheduled.
 */
export function nextWorkflowRun(
  schedule: WorkflowSchedule,
  lastRun: string | null | undefined,
  now: Date,
): Date | null {
  const candidates = schedule.rules
    .map((rule) => nextOccurrence(rule, now))
    .filter((date): date is Date => date !== null);
  if (schedule.interval) {
    const base = lastRun ? new Date(lastRun).getTime() : now.getTime();
    candidates.push(
      new Date(Math.max(now.getTime(), base + intervalMs(schedule.interval))),
    );
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((best, date) =>
    date.getTime() < best.getTime() ? date : best,
  );
}
