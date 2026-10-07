/**
 * Words and numbers of the phone page: uptimes, countdowns, log and notice
 * times, day headings. Spanish, like every user-facing string.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DATE = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const pad = (value: number): string => String(value).padStart(2, '0');

/** How long something has been running: "ahora", "34m", "1h 12m", "2d 3h". */
export function uptime(ms: number): string {
  if (ms < MINUTE) return 'ahora';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY)
    return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

/** Whole seconds left, rounded up so 0 means really over. */
export function countdown(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/** Whole seconds as "m:ss": 42 → "0:42", 125 → "2:05". */
export function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

export function clockTime(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function hourMinute(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shortDate(ts: number): string {
  return DATE.format(ts);
}

const startOfDay = (ts: number): number => {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** The heading a notice is grouped under. */
export function dayLabel(ts: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  return shortDate(ts);
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
