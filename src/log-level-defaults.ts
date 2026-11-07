/**
 * The default warn/error detectors a command gets when the user writes none.
 *
 * Dependency-free on purpose: main (normalization, migrations) AND the
 * renderer (the command dialog prefills these) import this one source.
 * Every pattern is compiled with flag `i` by `safeRegex`.
 */

/**
 * A level word only counts as a standalone token: not glued to a path,
 * file name, flag or identifier (`src/errors/`, `error-handler.ts`,
 * `--no-warnings`, `error_count`, `errorHandler`). `\b` alone is not enough
 * because it breaks on `-`, `.` and `/`.
 */
const TOKEN_START = String.raw`(?<![\w./\\-])`;
/** ...and the token must end: no `-`/word char next, no `.js`/`/list` tail. */
const TOKEN_END = String.raw`(?![\w-]|[./\\]\w)`;
/** Summaries reporting that nothing went wrong: `0 errors`, `no warnings`. */
const NOT_NEGATED = String.raw`(?<!\b(?:0|no|zero|without)\s+)`;

/**
 * Error: `error(s)`, npm's `ERR!`, `fatal`, `uncaught` as tokens, or any
 * `<Something>Error:` / `<Something>Exception:` label (`TypeError: …`).
 */
export const DEFAULT_ERROR_REGEX =
  `${TOKEN_START}${NOT_NEGATED}(?:errors?|err!|fatal|uncaught)${TOKEN_END}` +
  String.raw`|${TOKEN_START}\w*(?:error|exception):`;

/**
 * Warn: `warn`, `warning(s)` as tokens, or any `<Something>Warning:` label
 * (`DeprecationWarning: …`).
 */
export const DEFAULT_WARN_REGEX =
  `${TOKEN_START}${NOT_NEGATED}warn(?:ing)?s?${TOKEN_END}` +
  String.raw`|${TOKEN_START}\w*warning:`;

/** The defaults earlier versions stored verbatim on every command. */
export const LEGACY_DEFAULT_WARN_REGEX = String.raw`\bwarn(ing)?s?\b`;
export const LEGACY_DEFAULT_ERROR_REGEX = String.raw`\berror(s)?\b`;

/**
 * A stored detector that is EXACTLY an old default becomes the current one;
 * anything else is the user's own regex and is returned untouched.
 */
export function upgradeLegacyDefaultRegex(source: string): string {
  if (source === LEGACY_DEFAULT_WARN_REGEX) return DEFAULT_WARN_REGEX;
  if (source === LEGACY_DEFAULT_ERROR_REGEX) return DEFAULT_ERROR_REGEX;
  return source;
}
