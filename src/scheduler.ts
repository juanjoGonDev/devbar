import type {
  Schedule,
  ScheduleRule,
  WorkflowSchedule,
} from './domain-types.js';
import { nextRuns, type PlannableSchedule } from './schedule-plan.js';

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

/**
 * Whether an interval («Cada…») run fell in `(lastRun, now]`. However many
 * runs were missed (asleep, app closed), this says yes once; the caller then
 * moves the marker to `now`, so a catch-up fires at most one run. Never due
 * before a first run was recorded: the runner seeds the marker instead.
 */
function isIntervalDue(
  schedule: PlannableSchedule,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  if (!lastRun) return false;
  const [next] = nextRuns(schedule, new Date(lastRun), 1);
  return next !== undefined && next.getTime() <= now.getTime();
}

/**
 * A command or action schedule. In interval mode the runs come from
 * `nextRuns`, exactly what the editor previews; otherwise the weekday rules
 * decide, catching up on the most recent missed occurrence.
 */
export function isDue(
  schedule: Schedule | null | undefined,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  if (!schedule?.enabled) return false;
  if (schedule.interval) return isIntervalDue(schedule, lastRun, now);
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

/**
 * A workflow's schedule: the same rule as `isDue` for an enabled schedule.
 * Whether it is armed is the workflow's `enabled`, decided by the caller.
 */
export function isWorkflowScheduleDue(
  schedule: WorkflowSchedule,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  return isDue({ enabled: true, ...schedule }, lastRun, now);
}

/**
 * When the schedule fires next, strictly after `now`, as `nextRuns` plans
 * it. Interval runs sit on a fixed grid, so the last run no longer moves
 * them; `_lastRun` stays for the callers that pass it. Null when nothing is
 * scheduled.
 */
export function nextWorkflowRun(
  schedule: WorkflowSchedule,
  _lastRun: string | null | undefined,
  now: Date,
): Date | null {
  return nextRuns(schedule, now, 1)[0] ?? null;
}
