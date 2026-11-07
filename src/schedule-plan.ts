/**
 * When a schedule fires, and how it reads in Spanish. Pure and free of Node
 * imports on purpose: the renderer previews the very same runs the main
 * process fires, so the editor and the engine can never disagree.
 *
 * Everything is local wall-clock time. Each candidate run is built with
 * `new Date(y, m, d, 0, minutes)`, so a DST change moves no run off its wall
 * time: a time inside the skipped spring hour folds forward (02:30 → 03:30)
 * and collapses with any run already there, and the repeated autumn hour is
 * not repeated.
 *
 * Interval («Cada…») mode, the rules:
 * - Runs are anchored to the window start (or midnight) of each day and step
 *   `every` units from there until the window end (included) or the end of
 *   the day; the grid restarts the next day, so `every` 7 hours fires at
 *   00:00, 07:00, 14:00 and 21:00.
 * - A window with `to <= from` crosses midnight and belongs to the day it
 *   starts: the weekday filter is checked against that day.
 * - `every` N days fires once, at the window start (or midnight), on the days
 *   whose local calendar day number is a multiple of N, so the grid is fixed
 *   and never drifts with the last run.
 */
import type {
  ScheduleInterval,
  ScheduleRule,
  ScheduleWindow,
} from './domain-types.js';

/** What the plan needs from a `Schedule` or a `WorkflowSchedule`. */
export interface PlannableSchedule {
  rules: ScheduleRule[];
  interval: ScheduleInterval | null;
}

const MINUTES_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;
const UNIT_MINUTES = { minutes: 1, hours: 60 } as const;

function minutesOf(time: string): number {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return (
    (Number.isFinite(hour) ? hour : 0) * 60 +
    (Number.isFinite(minute) ? minute : 0)
  );
}

function wallTime(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

function onDay(days: readonly number[], day: Date): boolean {
  return days.length === 0 || days.includes(day.getDay());
}

/** Days since 1970-01-01 of the local calendar date, DST-free. */
function dayNumber(day: Date): number {
  return Math.round(
    Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / MS_PER_DAY,
  );
}

function windowLength(window: ScheduleWindow): number {
  const length =
    (minutesOf(window.to) - minutesOf(window.from) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  return length === 0 ? MINUTES_PER_DAY : length;
}

function intervalRunsOn(interval: ScheduleInterval, day: Date): Date[] {
  if (!onDay(interval.days, day)) return [];
  const every = Math.max(1, Math.round(interval.every));
  const anchor = interval.window ? minutesOf(interval.window.from) : 0;
  if (interval.unit === 'days')
    return dayNumber(day) % every === 0 ? [wallTime(day, anchor)] : [];
  const length = interval.window
    ? windowLength(interval.window)
    : MINUTES_PER_DAY;
  // A real window includes its end («de 9:00 a 18:00» fires at 18:00); a
  // whole day does not, or midnight would fire twice.
  const last = length < MINUTES_PER_DAY ? length : length - 1;
  const step = every * UNIT_MINUTES[interval.unit];
  const runs: Date[] = [];
  for (let offset = 0; offset <= last; offset += step)
    runs.push(wallTime(day, anchor + offset));
  return runs;
}

function ruleRunsOn(rules: readonly ScheduleRule[], day: Date): Date[] {
  return rules
    .filter((rule) => onDay(rule.days, day))
    .map((rule) => wallTime(day, minutesOf(rule.time)));
}

/** How many days may pass without a run before the schedule is empty. */
function searchHorizon(schedule: PlannableSchedule): number {
  const { interval } = schedule;
  return interval?.unit === 'days' ? 7 * Math.max(1, interval.every) + 2 : 9;
}

/**
 * The next `count` runs strictly after `from`, in order. Interval mode when
 * `schedule.interval` is set (the rules are then ignored), the weekday + time
 * rules otherwise. Empty when nothing would ever fire.
 */
export function nextRuns(
  schedule: PlannableSchedule,
  from: Date,
  count: number,
): Date[] {
  const runs: Date[] = [];
  if (count <= 0) return runs;
  const { interval } = schedule;
  const runsOn = (day: Date): Date[] =>
    interval ? intervalRunsOn(interval, day) : ruleRunsOn(schedule.rules, day);
  const horizon = searchHorizon(schedule);
  // Start the day before: its window may cross into `from`'s day.
  let lastHit = -1;
  for (let ahead = -1; ahead - lastHit <= horizon; ahead++) {
    const day = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + ahead,
    );
    const candidates = runsOn(day).sort((a, b) => a.getTime() - b.getTime());
    for (const run of candidates) {
      const floor = runs.at(-1)?.getTime() ?? from.getTime();
      if (run.getTime() <= floor) continue;
      runs.push(run);
      lastHit = ahead;
      if (runs.length === count) return runs;
    }
  }
  return runs;
}

// ── Spanish text ────────────────────────────────────────────────────────────

/** Weekdays in the order a Spanish week reads, Monday first. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const LETTERS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'] as const;
const NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;
const PLURALS = [
  'domingos',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábados',
] as const;

type DaySet =
  | { kind: 'all' }
  | { kind: 'weekdays' }
  | { kind: 'weekend' }
  | { kind: 'range'; first: number; last: number }
  | { kind: 'list'; days: number[] };

function daySet(days: readonly number[]): DaySet {
  const ordered = WEEK.filter((day) => days.includes(day));
  if (ordered.length === 0 || ordered.length === 7) return { kind: 'all' };
  const key = ordered.join(',');
  if (key === '1,2,3,4,5') return { kind: 'weekdays' };
  if (key === '6,0') return { kind: 'weekend' };
  const start = WEEK.indexOf(ordered[0] as (typeof WEEK)[number]);
  const contiguous = ordered.every((day, i) => WEEK[start + i] === day);
  if (contiguous && ordered.length >= 3)
    return {
      kind: 'range',
      first: ordered[0] ?? 1,
      last: ordered.at(-1) ?? 1,
    };
  return { kind: 'list', days: ordered };
}

function joinSpanish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1) ?? ''}`;
}

function longDays(days: readonly number[]): string {
  const set = daySet(days);
  switch (set.kind) {
    case 'all':
      return 'todos los días';
    case 'weekdays':
      return 'de lunes a viernes';
    case 'weekend':
      return 'los fines de semana';
    case 'range':
      return `de ${NAMES[set.first] ?? ''} a ${NAMES[set.last] ?? ''}`;
    case 'list':
      return `los ${joinSpanish(set.days.map((day) => PLURALS[day] ?? ''))}`;
  }
}

function shortDays(days: readonly number[]): string | null {
  const set = daySet(days);
  switch (set.kind) {
    case 'all':
      return null;
    case 'weekdays':
      return 'L–V';
    case 'weekend':
      return 'S–D';
    case 'range':
      return `${LETTERS[set.first] ?? ''}–${LETTERS[set.last] ?? ''}`;
    case 'list':
      return set.days.map((day) => LETTERS[day] ?? '').join(', ');
  }
}

/** `'09:00'` → `'9:00'`. */
function clock(time: string): string {
  const minutes = minutesOf(time);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `'09:00'` → `'9'`, `'09:30'` → `'9:30'`. */
function hourMark(time: string): string {
  const minutes = minutesOf(time);
  const hour = String(Math.floor(minutes / 60));
  return minutes % 60 === 0 ? hour : clock(time);
}

const UNIT_WORDS = {
  minutes: ['minuto', 'minutos', 'min'],
  hours: ['hora', 'horas', 'h'],
  days: ['día', 'días', 'días'],
} as const;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Rules grouped by identical weekdays, in first-seen order, times sorted. */
function ruleGroups(
  rules: readonly ScheduleRule[],
): { days: number[]; times: string[] }[] {
  const groups = new Map<string, { days: number[]; times: string[] }>();
  for (const rule of rules) {
    const days = WEEK.filter((day) => rule.days.includes(day));
    const key = days.length === 7 ? '' : days.join(',');
    const group = groups.get(key) ?? { days, times: [] };
    if (!group.times.includes(rule.time)) group.times.push(rule.time);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    days: group.days,
    times: [...group.times].sort(),
  }));
}

function describeInterval(interval: ScheduleInterval): string {
  const [one, many] = UNIT_WORDS[interval.unit];
  const head =
    interval.every === 1 ? `Cada ${one}` : `Cada ${interval.every} ${many}`;
  const allDays = daySet(interval.days).kind === 'all';
  if (interval.unit === 'days') {
    const parts = [head, `a las ${clock(interval.window?.from ?? '00:00')}`];
    if (!allDays) parts.push(longDays(interval.days));
    return parts.join(', ');
  }
  const parts = [head];
  if (interval.window)
    parts.push(
      `de ${clock(interval.window.from)} a ${clock(interval.window.to)}`,
    );
  parts.push(longDays(interval.days));
  return parts.join(', ');
}

/**
 * The long Spanish sentence for a schedule: «Cada 15 minutos, de 9:00 a
 * 18:00, de lunes a viernes», «A las 08:00 de lunes a viernes», «Cada día a
 * las 08:00 y a las 18:30». «Sin horario» when nothing is scheduled.
 */
export function describeSchedule(schedule: PlannableSchedule): string {
  if (schedule.interval) return describeInterval(schedule.interval);
  const groups = ruleGroups(schedule.rules);
  if (groups.length === 0) return 'Sin horario';
  const clauses = groups.map(({ days, times }) => {
    const at = joinSpanish(times.map((time) => `a las ${time}`));
    return daySet(days).kind === 'all'
      ? `cada día ${at}`
      : `${at} ${longDays(days)}`;
  });
  return capitalize(clauses.join('; '));
}

/**
 * The badge form: «08:00 · L–V», «cada 15 min · 9–18 h · L–V», «cada 2 h».
 * The weekdays are left out when the schedule runs every day.
 */
export function shortSchedule(schedule: PlannableSchedule): string {
  const { interval } = schedule;
  if (interval) {
    const [one, , short] = UNIT_WORDS[interval.unit];
    const parts = [
      interval.every === 1 ? `cada ${one}` : `cada ${interval.every} ${short}`,
    ];
    if (interval.unit === 'days') parts.push(interval.window?.from ?? '00:00');
    else if (interval.window)
      parts.push(
        `${hourMark(interval.window.from)}–${hourMark(interval.window.to)} h`,
      );
    const days = shortDays(interval.days);
    if (days) parts.push(days);
    return parts.join(' · ');
  }
  const groups = ruleGroups(schedule.rules);
  const [first] = groups;
  if (!first) return 'Sin horario';
  if (groups.length > 1) {
    const days = shortDays(first.days);
    const base = days ? `${first.times[0]} · ${days}` : (first.times[0] ?? '');
    return `${base} +${schedule.rules.length - 1}`;
  }
  const days = shortDays(first.days);
  const times = first.times.join(', ');
  return days ? `${times} · ${days}` : times;
}
