/**
 * The badge in a row's level column: INF, DBG, WRN or ERR.
 *
 * Warn and error come from the command's own detectors (main classifies each
 * line as it arrives); debug is only a guess from the text, since no detector
 * exists for it — a standalone `debug`/`DBG` token, `[debug]`, `level=debug`.
 * The detectors always win: a line they flagged is that level whatever it says.
 */
import { stripAnsi } from './ansi.js';
import { levelOf } from './filters.js';
import type { LogEntry } from '../../src/domain-types.js';

export type Badge = 'inf' | 'dbg' | 'wrn' | 'err';

export const BADGE_LABEL: Readonly<Record<Badge, string>> = {
  inf: 'INF',
  dbg: 'DBG',
  wrn: 'WRN',
  err: 'ERR',
};

// A whole token: not part of `debugger`, `undebuggable` or `debug-free`.
const DEBUG_TOKEN = /(?:^|[^\w-])(?:debug|dbg)(?![\w-])/i;

export function looksDebug(text: string): boolean {
  return DEBUG_TOKEN.test(stripAnsi(text));
}

export function badgeOf(entry: LogEntry): Badge {
  const level = levelOf(entry);
  if (level === 'error') return 'err';
  if (level === 'warn') return 'wrn';
  return looksDebug(entry.line) ? 'dbg' : 'inf';
}
