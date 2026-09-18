const SHELL_META = /[&|;<>$`*?(){}\[\]]/;
export function tokenize(cmdline: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  for (let index = 0; index < cmdline.length; index++) {
    const char = cmdline[index];
    if (char === undefined) continue;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && index + 1 < cmdline.length) {
        index++;
        current += cmdline[index] ?? '';
      } else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
    } else if (char === ' ' || char === '\t') {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
    } else if (char === '\\' && index + 1 < cmdline.length) {
      index++;
      current += cmdline[index] ?? '';
      hasContent = true;
    } else {
      current += char;
      hasContent = true;
    }
  }
  if (hasContent) tokens.push(current);
  return tokens;
}
export function hasShellMeta(value: string): boolean {
  return SHELL_META.test(value);
}
export function splitCommand(
  command: string | null | undefined,
  args: readonly string[] | null | undefined,
): { command: string; args: string[] } {
  const cmd = (command ?? '').trim();
  if (!cmd) return { command: '', args: args ? [...args] : [] };
  if (args?.length) return { command: cmd, args: [...args] };
  if (!/\s/.test(cmd) || hasShellMeta(cmd)) return { command: cmd, args: [] };
  const tokens = tokenize(cmd);
  const executable = tokens[0] ?? cmd;
  return tokens.length <= 1
    ? { command: cmd, args: [] }
    : { command: executable, args: tokens.slice(1) };
}
function shellQuote(value: string | null | undefined): string {
  if (value == null || value === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@+,]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export function buildCmdline(
  command: string | null | undefined,
  args: readonly string[] | null | undefined,
): string {
  const cmd = (command ?? '').trim();
  if (!args?.length) return cmd;
  return `${cmd} ${args.some(hasShellMeta) ? args.join(' ') : args.map(shellQuote).join(' ')}`;
}

/**
 * Quote one ARGUMENT for a Windows command line. There are THREE parsers
 * between this string and the child process, and the first one has to be
 * switched OFF for the other two to see what is written here:
 *
 * 0. libuv's `quote_cmd_arg`. Windows has no argv array — the OS takes a
 *    single command line string — so libuv normally re-quotes every
 *    element of Node's `args` array, wrapping it and backslash-escaping
 *    each `"` inside it as `\"`. cmd.exe has NO backslash escape, so those
 *    backslashes survive to the child, where `CommandLineToArgvW` reads
 *    `\"` as a literal quote rather than the span toggle emitted below —
 *    silently splitting `--title "My App"` into three arguments. This
 *    layer is BYPASSED: every spawn of the shell sets
 *    `windowsVerbatimArguments` (see serviceSpawnOptions in
 *    process-manager.ts), which hands libuv the line untouched, and the
 *    `/c` payload is wrapped in the one quote pair `cmd /s` strips back
 *    off. With that flag the remaining two parsers are the only ones this
 *    encoding has to satisfy:
 *
 * 1. `cmd.exe` reads the line first and treats `& | < > ^` OUTSIDE double
 *    quotes as operators (chain / pipe / redirect / escape) — a raw `>`
 *    would redirect the child's output, `&` would chain. It also expands
 *    `%NAME%` environment references even inside double quotes, so a
 *    literal `%` only survives as `^%` OUTSIDE a quoted span.
 * 2. The child re-parses the argument vector with the MSVCRT
 *    `CommandLineToArgvW` rules (double quotes group, backslashes escape
 *    quotes): an argument with whitespace needs `"…"` or the child would
 *    see it as several arguments (POSIX single quotes are meaningless to
 *    both cmd and the child — they would arrive as literal characters).
 *
 * Combined rules:
 * - empty, or containing whitespace/`"` → a state machine tracks BOTH
 *   parsers' quoted state at once (see quoteWindowsArgQuoted) so every
 *   emitted character is legal for whichever parser reads it: spaces
 *   only inside a child span, `%` only as `^%` outside a cmd span,
 *   literal quotes only as `\"` outside a child span, backslash runs
 *   doubled exactly where a quote follows in the OUTPUT;
 * - otherwise → emit as-is, but prefix each cmd operator and percent sign
 *   with `^` so cmd passes it through uninterpreted.
 *
 * The two remaining reference parsers (cmd escape/expansion, then
 * CommandLineToArgvW) are simulated in tests and the round-trip
 * `parse(cmd(quote(v))) === v` is asserted for a battery of values, plus a
 * real cmd.exe round-trip on Windows CI that goes through the production
 * spawn spec — so the `windowsVerbatimArguments` bypass above is part of
 * what that round-trip proves.
 */
function isArgSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v';
}
/**
 * The QUOTED encoding, as a single state machine tracking BOTH parsers
 * simultaneously:
 *  - `cmdQ`  — whether the next character is inside a cmd.exe quoted span
 *             (cmd toggles on EVERY double-quote; it ignores backslashes);
 *  - `childQ`— the child's CommandLineToArgvW quoted state (a `\"` does
 *             NOT toggle it; an even backslash run before a quote still
 *             does).
 * Invariants the transitions maintain:
 *  - a space is only ever emitted while `childQ` (or it would split the
 *    argument in the child's parser);
 *  - a `%` is only ever emitted as `^%` while `!cmdQ` (or cmd would
 *    expand %NAME% — even inside quotes);
 *  - a literal `"` is only ever emitted as `\"` while `!childQ` (a quote
 *    inside a child span would close it, not be content).
 */
function quoteWindowsArgQuoted(value: string): string {
  // Start inside the span: classic `"…"` form for the common case; the
  // state machine closes/reopens it only where a parser requires it.
  let out = '"';
  let cmdQ = true;
  let childQ = true;
  // A bare quote toggles BOTH parsers.
  const quote = (): void => {
    out += '"';
    cmdQ = !cmdQ;
    childQ = !childQ;
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (isArgSpace(ch)) {
      if (!childQ) quote();
      out += ch;
    } else if (ch === '%') {
      if (cmdQ) quote();
      out += '^%';
    } else if (ch === '"') {
      if (childQ) quote();
      out += '\\"';
      cmdQ = !cmdQ; // \" is a literal for the child, a toggle for cmd
    } else if (ch === '\\') {
      let n = 0;
      while (i + n < value.length && value[i + n] === '\\') n++;
      const next = value[i + n];
      if (next === '"') {
        // n literal backslashes + a LITERAL quote for the child: 2n+1
        // backslashes before a quote. The quote is still a toggle for cmd.
        out += '\\'.repeat(2 * n + 1) + '"';
        cmdQ = !cmdQ;
        i += n; // the loop's i++ then skips the consumed quote
      } else if (next === undefined) {
        // Argument end: the final closing quote (below) is adjacent when
        // childQ; with !childQ no quote follows and the run is literal.
        out += '\\'.repeat(childQ ? 2 * n : n);
        i += n - 1;
      } else if (isArgSpace(next)) {
        // A space follows: when !childQ the space handler emits a span
        // OPEN immediately after these backslashes — even them out.
        out += '\\'.repeat(childQ ? n : 2 * n);
        i += n - 1;
      } else if (next === '%') {
        // The % handler may emit a span CLOSE right after these
        // backslashes (when cmdQ) — even them out.
        out += '\\'.repeat(cmdQ ? 2 * n : n);
        i += n - 1;
      } else {
        out += '\\'.repeat(n);
        i += n - 1;
      }
    } else if (
      !cmdQ &&
      (ch === '&' ||
        ch === '|' ||
        ch === '<' ||
        ch === '>' ||
        ch === '^' ||
        ch === '(' ||
        ch === ')')
    ) {
      // Outside a cmd span these are command syntax (chain / pipe /
      // redirect / escape / compound-statement grouping) — escape them
      // so cmd passes them through. Inside a span cmd treats them
      // literally, so no escape there (and the child, which never sees
      // carets, wants the raw char).
      out += `^${ch}`;
    } else {
      out += ch;
    }
  }
  if (childQ) out += '"';
  return out;
}
export function quoteWindowsArg(value: string): string {
  if (value === '' || /[ \t\n\v"]/.test(value)) {
    return quoteWindowsArgQuoted(value);
  }
  // Parentheses included: cmd.exe treats unquoted ( ) as compound-
  // statement grouping, so foo(bar) would be command syntax, not data.
  return value.replace(/[&|<>^%()]/g, '^$&');
}

/**
 * Windows counterpart of buildCmdline: the command itself stays free
 * form (the user may write cmd syntax in it, e.g. `cd /d dir && run`),
 * but the structured args are literal and must survive both cmd.exe and
 * CommandLineToArgvW — hence per-argument quoteWindowsArg, never POSIX
 * quoting, never raw joining (raw joining is what let `>`/`&` turn into
 * redirects and chains).
 */
export function buildCmdlineWindows(
  command: string | null | undefined,
  args: readonly string[] | null | undefined,
): string {
  const cmd = (command ?? '').trim();
  if (!args?.length) return cmd;
  return `${cmd} ${args.map(quoteWindowsArg).join(' ')}`;
}
