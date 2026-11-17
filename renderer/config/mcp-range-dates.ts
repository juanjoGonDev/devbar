/**
 * The calendar arithmetic and the words of the «Rango…» picker
 * (mcp-range-picker.ts), in local time: days are local midnights as epoch
 * ms, weeks start on Monday, and a step of days or months follows the
 * calendar rather than a fixed number of hours, so a DST change moves
 * nothing.
 */

export const WEEKDAYS: readonly (readonly [string, string])[] = [
  ['L', 'lunes'],
  ['M', 'martes'],
  ['X', 'miércoles'],
  ['J', 'jueves'],
  ['V', 'viernes'],
  ['S', 'sábado'],
  ['D', 'domingo'],
];
const END_DAY = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
});
const MONTH = new Intl.DateTimeFormat('es-ES', {
  month: 'long',
  year: 'numeric',
});
export const FULL_DAY = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full' });

export const pad = (n: number): string => String(n).padStart(2, '0');

export function midnight(ms: number): number {
  const at = new Date(ms);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}

export function monthOf(ms: number): number {
  const at = new Date(ms);
  return new Date(at.getFullYear(), at.getMonth(), 1).getTime();
}

/** `n` calendar days away (a DST day is still one day). */
export function addDays(day: number, n: number): number {
  const at = new Date(day);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + n).getTime();
}

/** The same day `n` months away, or that month's last when it is shorter. */
export function addMonths(day: number, n: number): number {
  const at = new Date(day);
  const first = new Date(at.getFullYear(), at.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  first.setDate(Math.min(at.getDate(), last.getDate()));
  return first.getTime();
}

/** Monday 0 … Sunday 6. */
export const weekday = (day: number): number =>
  (new Date(day).getDay() + 6) % 7;

export function monthTitle(month: number): string {
  const text = MONTH.format(month);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «28 oct · 22:35», or «Sin límite» for an open end. */
export function endText(ms: number | undefined): string {
  if (ms === undefined) return 'Sin límite';
  const at = new Date(ms);
  return `${END_DAY.format(at).replace('.', '')} · ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Where a key moves the grid's focus from `day`, or null for other keys. */
export function moved(day: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1);
    case 'ArrowRight':
      return addDays(day, 1);
    case 'ArrowUp':
      return addDays(day, -7);
    case 'ArrowDown':
      return addDays(day, 7);
    case 'Home':
      return addDays(day, -weekday(day));
    case 'End':
      return addDays(day, 6 - weekday(day));
    case 'PageUp':
      return addMonths(day, -1);
    case 'PageDown':
      return addMonths(day, 1);
    default:
      return null;
  }
}
