import type { ProblemEntry } from './error-journal.js';

/**
 * The «Errores y avisos recientes» section of the bug report, as pure
 * text: one entry per problem, newest first, each marked with the session
 * that hit it. Redaction is the caller's (src/report-issue.ts), and it
 * runs BEFORE anything here shortens a message, so no cut can split a
 * secret open.
 */

const PROBLEMS_HEADING = '### Errores y avisos recientes';

/** How much of each message rides in the URL; the clipboard keeps it all. */
export const URL_ENTRY_CHARS = 300;

export function countProblems(entries: readonly ProblemEntry[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  for (const e of entries) if (e.level === 'error') errors += 1;
  return { errors, warnings: entries.length - errors };
}

/**
 * A fence strictly longer than any backtick run in the content: a fixed
 * ``` would let content that quotes markdown close the block early.
 */
export function fenceFor(content: string): string {
  const longestRun = content
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, (longestRun ?? 0) + 1));
}

/** Cuts at `max` chars without leaving half a surrogate pair behind —
 *  encodeURIComponent throws on a lone one. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

export function formatProblem(
  entry: ProblemEntry,
  session: string,
  maxChars = Number.POSITIVE_INFINITY,
): string {
  const where = entry.session === session ? 'esta sesión' : 'sesión anterior';
  const repeats = entry.count > 1 ? ` ×${String(entry.count)}` : '';
  return `[${entry.ts}] [${entry.level}] [${entry.source}] (${where})${repeats}\n${shorten(entry.message, maxChars)}`;
}

/**
 * The section itself. `items` are formatted entries, newest first;
 * `omitted` says how many did not fit (the URL) and where they are.
 */
export function problemsSection(items: string[], omitted: number): string {
  const lines = [PROBLEMS_HEADING, ''];
  if (items.length > 0) {
    const content = items.join('\n\n');
    const fence = fenceFor(content);
    lines.push(`${fence}text`, content, fence);
  } else if (omitted === 0) lines.push('Ninguno registrado');
  if (omitted > 0)
    lines.push(
      ...(items.length > 0 ? [''] : []),
      items.length > 0
        ? `_… y ${String(omitted)} más en el portapapeles._`
        : `_${String(omitted)} en el portapapeles (no caben en la URL)._`,
    );
  return lines.join('\n');
}
