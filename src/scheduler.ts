import type { Schedule, ScheduleRule } from './domain-types.js';
export function mostRecentOccurrence(
  rule: ScheduleRule,
  now: Date,
): Date | null {
  const [hour = 0, minute = 0] = rule.time.split(':').map(Number);
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
