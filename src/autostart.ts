import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cross-platform "open at login" — the platform-neutral half.
 *
 * What each OS uses, and why the `--login` argument exists:
 * - macOS:  Electron login item; `wasOpenedAtLogin` is a native signal.
 * - Windows: Electron login item writing the per-user Run registry key, with
 *   a `--login` argument so the app can tell a boot launch from a manual one.
 * - Linux:  Electron has no login-item support, so a XDG autostart .desktop
 *   file is written by hand. Same `--login` argument convention.
 *
 * The Electron-specific dispatch (setLoginItemSettings / reading the macOS
 * signal) lives in main.ts, which is the only place that may import electron.
 */

export const LOGIN_ARG = '--login';
export const DESKTOP_FILE_NAME = 'devbar.desktop';

/** Where XDG autostart lives for the current user. */
export function autostartDesktopPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', DESKTOP_FILE_NAME);
}

/**
 * Desktop Entry quoting (spec §7, "The Exec key"). Kept byte-for-byte
 * equivalent to renderDesktopEntry in scripts/register-launcher.ts — the
 * two write the same kind of file for the same executable, so they must
 * not disagree about what a backslash or a newline becomes.
 *
 * A literal % is doubled FIRST: field codes (%f, %u, …) are expanded once
 * by the desktop environment after unquoting, so an install path
 * containing one would launch with a mangled path. Then a value with
 * whitespace or a reserved character goes in double quotes, and inside
 * those:
 *
 *  - `"`, `$` and backtick take ONE backslash (the quoting unescape);
 *  - a literal `\` takes FOUR, because the generic string unescape
 *    (`\\` -> `\`) runs BEFORE the quoting unescape, so two levels are
 *    consumed — two backslashes would arrive at the launcher as none;
 *  - a newline, tab or carriage return has NO literal form in a
 *    line-based key file: emitted raw, a newline would end the `Exec=`
 *    line and the remainder would be read as a second key. They take
 *    their generic string escapes (`\n`, `\t`, `\r`) instead.
 *
 * One character-mapping pass, so an escape this function emits is never
 * re-escaped by a later stage (chained replaces would double them, and
 * static checkers flag them as single-stage anyway).
 */
function desktopQuote(value: string): string {
  const escaped = value.replace(/%/g, '%%');
  if (!/[\s"'`$\\]/.test(escaped)) return escaped;
  const body = escaped.replace(/[\\`$"\n\t\r]/g, (ch) => {
    if (ch === '\\') return '\\\\\\\\';
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    if (ch === '\r') return '\\r';
    return `\\${ch}`;
  });
  return `"${body}"`;
}

/**
 * Render the XDG autostart file content. `exec` must be the packaged
 * executable; the `--login` argument is what makes a boot launch
 * recognisable later. The executable is quoted per the spec — the
 * desktop environment splits the Exec field on whitespace, so an
 * unquoted install path with a space would truncate the launch.
 */
export function desktopFileContent(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=DevBar',
    'Comment=Menu bar launcher for local development services',
    `Exec=${desktopQuote(exec)} ${LOGIN_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Write or remove the Linux autostart entry. */
export function setLinuxAutostart(exec: string, enabled: boolean): void {
  const file = autostartDesktopPath();
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopFileContent(exec), 'utf8');
}

/** Whether the Linux autostart entry is present. */
export function linuxAutostartPresent(): boolean {
  return fs.existsSync(autostartDesktopPath());
}

/**
 * Whether this launch came from the OS login mechanism (i.e. the machine
 * just booted / the user just logged in) rather than a manual open. That
 * signal gates the pre-scripts' boot auto-run: re-running a `make setup`
 * style script on every manual quit-and-reopen would be wrong.
 *
 * macOS reports it natively (checked in main, which owns the electron
 * import); Windows and Linux pass `--login` themselves, so argv is the
 * signal here.
 */
export function wasOpenedAtLoginFromArgv(): boolean {
  return process.argv.includes(LOGIN_ARG);
}
