/**
 * The «PRÓXIMAS» pills of the schedule editor: «hoy 12:30», «mañana 08:00»,
 * «miércoles 08:00», or the date a week or more away. A run on the same day
 * as the one before it shows only its time («hoy 12:30», «12:45»).
 */

const WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;
const MS_PER_DAY = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Calendar days from `from` to `to`, DST-free. */
function daysBetween(from: Date, to: Date): number {
  const utc = (d: Date): number =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((utc(to) - utc(from)) / MS_PER_DAY);
}

function dayLabel(run: Date, now: Date): string {
  const ahead = daysBetween(now, run);
  if (ahead === 0) return 'hoy';
  if (ahead === 1) return 'mañana';
  if (ahead > 1 && ahead < 7) return WEEKDAYS[run.getDay()] ?? '';
  return `${run.getDate()}/${run.getMonth() + 1}`;
}

export function runLabels(runs: readonly Date[], now: Date): string[] {
  return runs.map((run, i) => {
    const time = `${pad(run.getHours())}:${pad(run.getMinutes())}`;
    const previous = runs[i - 1];
    return previous && daysBetween(previous, run) === 0
      ? time
      : `${dayLabel(run, now)} ${time}`;
  });
}
