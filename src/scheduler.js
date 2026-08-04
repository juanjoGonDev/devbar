'use strict';

/**
 * scheduler.js — pure, Electron-free schedule evaluation.
 *
 * This is anacron-style, NOT cron: instead of firing exactly at the wall-clock
 * time (which a sleeping Mac would miss), we compute the most recent scheduled
 * occurrence at or before `now` and fire whenever the command has not run since
 * that occurrence. A machine that was asleep at 09:00 and wakes at 09:30 still
 * sees 09:00 as the most-recent occurrence and catches up.
 *
 * Schedule shape (see groups-model.normalizeSchedule):
 *   { enabled: boolean, rules: [{ time: "HH:MM", days: number[] }] }
 *   days: weekday numbers 0=Sun … 6=Sat; empty array = every day.
 *   Multiple rules = multiple daily slots; a target is due if ANY rule is due.
 *
 * All computation is in LOCAL time — a "09:00" schedule means the user's 09:00.
 */

/**
 * The latest datetime <= now that matches a rule's time-of-day and (if
 * constrained) weekday. Returns a Date, or null if no match in the last week.
 * `rule` is { time: "HH:MM", days: number[] }.
 */
function mostRecentOccurrence(rule, now) {
  const [h, m] = String(rule.time).split(':').map(Number);
  const days = Array.isArray(rule.days) ? rule.days : [];
  for (let back = 0; back < 8; back++) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > now.getTime()) continue; // that time hasn't arrived yet
    if (days.length === 0 || days.includes(d.getDay())) return d;
  }
  return null;
}

/**
 * True when the command should be started now.
 * @param schedule normalized schedule (or falsy)
 * @param lastRun  ISO string of the last scheduled start, or null if never
 * @param now      Date
 */
function isDue(schedule, lastRun, now) {
  if (!schedule || !schedule.enabled) return false;
  const rules = Array.isArray(schedule.rules) ? schedule.rules : [];
  let best = null; // latest occurrence across all rules
  for (const rule of rules) {
    const occ = mostRecentOccurrence(rule, now);
    if (occ && (!best || occ.getTime() > best.getTime())) best = occ;
  }
  if (!best) return false;
  if (!lastRun) return true; // caller decides whether to seed instead of firing
  return new Date(lastRun).getTime() < best.getTime();
}

module.exports = { isDue, mostRecentOccurrence };
