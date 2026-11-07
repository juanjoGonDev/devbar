/**
 * Log lines that are JSON objects, read as JSON.
 *
 * Structured loggers print one object per line; raw, the keys drown in quotes
 * and braces. A line whose text — after an optional bracketed prefix such as
 * `[pid]` — parses as an object is drawn syntax-coloured on one line, cut at
 * a whole member, and can be opened into a pretty-printed block below it.
 *
 * Parsing is capped: a line past `MAX_JSON_CHARS` is never tried, and a line
 * is parsed at most once (`jsonOf` caches by entry), because rows are rebuilt
 * on every scroll and repaint. Whether a line is open is keyed by its entry,
 * so it survives both. Nothing here touches the DOM.
 */
import { stripAnsi } from './ansi.js';
import type { LogEntry } from '../../src/domain-types.js';

/** Past this many characters a line is drawn as text, unparsed. */
export const MAX_JSON_CHARS = 20_000;

export interface JsonLine {
  /** What came before the object, e.g. `[1234] `. */
  prefix: string;
  value: Record<string, unknown>;
}

const PREFIX = /^\s*((?:\[[^\]\n]*\]\s*)*)/;

export function parseJsonLine(line: string): JsonLine | null {
  if (line.length > MAX_JSON_CHARS) return null;
  const text = stripAnsi(line);
  const lead = PREFIX.exec(text);
  const prefix = lead?.[1] ?? '';
  const rest = text.slice(lead?.[0].length ?? 0).trim();
  if (!rest.startsWith('{') || !rest.endsWith('}')) return null;
  let value: unknown;
  try {
    value = JSON.parse(rest);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { prefix, value: value as Record<string, unknown> };
}

const parsed = new WeakMap<LogEntry, JsonLine | null>();

/** `parseJsonLine` for an entry, parsed once. */
export function jsonOf(entry: LogEntry): JsonLine | null {
  const known = parsed.get(entry);
  if (known !== undefined) return known;
  const result = parseJsonLine(entry.line);
  parsed.set(entry, result);
  return result;
}

export interface Compact {
  text: string;
  truncated: boolean;
}

/**
 * `{ "a": 1, "b": "x", … }` — members are added while they fit in `budget`
 * characters (the first always does), so a cut never lands mid-value.
 */
export function compactJson(
  value: Record<string, unknown>,
  budget: number,
): Compact {
  const members = Object.entries(value).map(
    ([key, member]) => `${JSON.stringify(key)}: ${JSON.stringify(member)}`,
  );
  if (!members.length) return { text: '{}', truncated: false };
  const kept: string[] = [];
  let used = 0;
  for (const member of members) {
    if (kept.length && used + member.length > budget) break;
    kept.push(member);
    used += member.length + 2;
  }
  const truncated = kept.length < members.length;
  const body = truncated ? [...kept, '…'] : kept;
  return { text: `{ ${body.join(', ')} }`, truncated };
}

type TokenKind = 'key' | 'str' | 'num' | 'lit' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;
}

// A string (and whether a colon follows, which makes it a key), a number, a
// literal — everything else is punctuation and whitespace.
const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** Split JSON text into coloured runs; joined back, they are the input. */
export function jsonTokens(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  const push = (kind: TokenKind, run: string): void => {
    if (!run) return;
    const prev = out[out.length - 1];
    if (kind === 'punct' && prev?.kind === 'punct') prev.text += run;
    else out.push({ kind, text: run });
  };
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
    push('punct', text.slice(last, match.index));
    const [, str, colon, num, lit] = match;
    if (str !== undefined) {
      push(colon ? 'key' : 'str', str);
      if (colon) push('punct', colon);
    } else if (num !== undefined) push('num', num);
    else if (lit !== undefined) push('lit', lit);
    last = TOKEN.lastIndex;
  }
  push('punct', text.slice(last));
  return out;
}

const opened = new WeakSet<LogEntry>();

export function isJsonOpen(entry: LogEntry): boolean {
  return opened.has(entry);
}

export function toggleJson(entry: LogEntry): void {
  if (opened.has(entry)) opened.delete(entry);
  else opened.add(entry);
}
