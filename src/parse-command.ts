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
