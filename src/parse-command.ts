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
 * Quote one ARGUMENT for a Windows command line. There are two parsers
 * between this string and the child process:
 *
 * 1. `cmd.exe` reads the line first and treats `& | < > ^` OUTSIDE double
 *    quotes as operators (chain / pipe / redirect / escape) — a raw `>`
 *    would redirect the child's output, `&` would chain. It also expands
 *    `%NAME%` environment references even inside quotes.
 * 2. The child re-parses the argument vector with the MSVCRT
 *    `CommandLineToArgvW` rules (double quotes group, backslashes escape
 *    quotes): an argument with whitespace needs `"…"` or the child would
 *    see it as several arguments (POSIX single quotes are meaningless to
 *    both cmd and the child — they would arrive as literal characters).
 *
 * Combined rules:
 * - empty, or containing whitespace/`"` → wrap in `"…"`, escaping `"` as
 *   `\"` and doubling backslash runs that precede a quote boundary. Literal
 *   percent signs briefly leave the quoted span so `^%` prevents expansion;
 * - otherwise → emit as-is, but prefix each cmd operator and percent sign
 *   with `^` so cmd passes it through uninterpreted.
 */
export function quoteWindowsArg(value: string): string {
  if (value === '' || /[ \t\n\v"]/.test(value)) {
    let out = '"';
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch !== '\\') {
        if (ch === '"') out += '\\"';
        else if (ch === '%') out += '"^%"';
        else out += ch;
        continue;
      }
      let n = 0;
      while (i + n < value.length && value[i + n] === '\\') n++;
      const next = value[i + n];
      if (next === '"') out += '\\'.repeat(2 * n + 1) + '"';
      else if (next === '%') out += '\\'.repeat(2 * n);
      else if (next === undefined) out += '\\'.repeat(2 * n);
      else out += '\\'.repeat(n);
      i += n - 1;
    }
    return out + '"';
  }
  return value.replace(/[&|<>^%]/g, '^$&');
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
