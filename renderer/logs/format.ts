/**
 * The small text transforms the log panes share: a clock, a stable colour per
 * service, and the skeleton that tells two sightings of the same event apart
 * from two different events.
 */
import { stripAnsi } from './ansi.js';

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0') +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

/**
 * «hace 12 s», «hace 3 min», «hace 2 h», «hace 1 d» — for the relative clock.
 * A stamp a little ahead of `now` (two clocks a few ms apart) reads as now.
 */
export function relativeTime(ts: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - ts) / 1000);
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/** Stable per-name hue, so one service keeps its tag colour between runs. */
export function sourceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 68%)`;
}

/**
 * Collapse a line to the shape it shares with its repeats: numbers, hex ids and
 * UUIDs vary run to run, the skeleton does not. Two lines with the same
 * skeleton are the same event happening twice.
 */
export function mutedKey(line: string): string {
  return stripAnsi(line)
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '§')
    .replace(/0x[0-9a-f]+/gi, '§')
    .replace(/\d+/g, '§')
    .slice(0, 200);
}
