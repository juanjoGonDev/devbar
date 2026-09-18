/**
 * Register an install-local'd DevBar in the OS launcher UI — the piece that
 * makes it discoverable the way a packaged install is (the .deb ships its
 * own .desktop entry, the NSIS installer creates its own shortcuts; an
 * unpacked copy is invisible to the app menu / Start Menu without these):
 *
 *   Linux:   ~/.local/share/applications/devbar.desktop
 *   Windows: %APPDATA%\Microsoft\Windows\Start Menu\Programs\DevBar.lnk
 *
 * Run by scripts/platform.ts right after scripts/install-local.ts on
 * win32/linux. Best effort by design: the install itself is already done,
 * so a broken launcher only warns — it never fails the install.
 *
 * IMPORTANT: this script is executed directly by Node's
 * --experimental-strip-types, which does NOT rewrite `.js` import
 * specifiers to `.ts` files — so, like the other strip-types scripts, it
 * may only import node: builtins and local modules written with their
 * `.ts` extension (see scripts/lib/script-runtime.ts).
 *
 * Usage: node --experimental-strip-types scripts/register-launcher.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteEnvDir, isEntrypoint } from './lib/script-runtime.ts';

/** Repo root: this script lives in <repo>/scripts/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The only part of a spawnSync result this script reacts to. */
export interface LauncherSpawnResult {
  status: number | null;
  error?: Error | undefined;
}

/** Subprocess seam: the real spawnSync in production, a fake in tests. */
export type LauncherSpawn = (
  command: string,
  args: readonly string[],
) => LauncherSpawnResult;

/** Progress output seam — the three prefixes this script speaks in. */
export interface LauncherReporter {
  step(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
}

const consoleReporter: LauncherReporter = {
  step: (message) => console.log(`→ ${message}`),
  ok: (message) => console.log(`✓ ${message}`),
  warn: (message) => console.log(`! ${message}`),
};

const spawnQuiet: LauncherSpawn = (command, args) =>
  spawnSync(command, [...args], { stdio: 'ignore' });

function tryQuiet(
  spawn: LauncherSpawn,
  cmd: string,
  args: readonly string[],
): void {
  try {
    spawn(cmd, args);
    /* best effort */
  } catch {
    /* binary missing is an expected outcome */
  }
}

export const DESKTOP_FILE_NAME = 'devbar.desktop';

/**
 * XDG user applications dir: $XDG_DATA_HOME/applications when set, else
 * ~/.local/share/applications. The XDG Base Directory Specification
 * requires these paths to be ABSOLUTE — a relative value would resolve
 * against the process CWD and the launcher could be written to a
 * directory that is not the application menu (while the script still
 * reports success), so only a non-empty absolute value is honored.
 */
export function desktopApplicationsDir(): string {
  const base = absoluteEnvDir(
    'XDG_DATA_HOME',
    path.join(os.homedir(), '.local', 'share'),
  );
  return path.join(base, 'applications');
}

/** The .desktop file that registers DevBar in the app menu. */
export function desktopLauncherPath(): string {
  return path.join(desktopApplicationsDir(), DESKTOP_FILE_NAME);
}

/**
 * XDG .desktop content for an installed copy. Exec points at the exact
 * executable of this install; the icon (when one was found next to the
 * app) is an absolute path — legal for user-local entries.
 *
 * Quoting follows the Desktop Entry spec (§7): a literal % is doubled
 * everywhere (field codes), a value containing any reserved character
 * goes in double quotes, and inside those only " ` $ \ are escaped —
 * a literal \ takes four backslashes (string unescape runs before quote
 * unescape). The `Icon` key is an ICONSTRING, not a desktop argument:
 * it is not double-quoted — backslash and `;` (the icon-list separator)
 * are backslash-escaped and whitespace is escaped as `\s`.
 */
export function renderDesktopEntry(
  executable: string,
  icon?: string | null,
): string {
  // Exec-line quoting per the Desktop Entry spec (§7 "The Exec key"):
  //  - A literal % must be doubled ANYWHERE on the command line: field
  //    codes (%u, %f, …) are expanded once, AFTER undo-quoting, so an
  //    unescaped % in the path would be mangled by the launcher.
  //  - A value containing any RESERVED character (whitespace plus
  //    " ' \ > < ~ | & ; $ * ? # ( ) and backtick) must be double-quoted.
  //  - Inside double quotes only " ` $ and \ are backslash-escaped — and a
  //    literal \ needs FOUR backslashes in the file, because the generic
  //    string unescape (\\ -> \) runs BEFORE the quoting unescape.
  const quote = (value: string): string => {
    let out = value.replace(/%/g, '%%');
    if (!/[\t\n\r "'\\><~|&;$*?#()`]/.test(value)) return out;
    // Inside quotes, only \ " ` $ are escaped — and a literal \ needs FOUR
    // backslashes in the file: the parser applies the generic string
    // unescape (\\ -> \) BEFORE the quoting unescape, so two levels are
    // consumed. A newline, tab or carriage return has no literal form in a
    // line-based key file — emitted raw, a newline would end the Exec= line
    // and the remainder would be read as a second key — so they take their
    // generic string escapes. One character-mapping pass (chained
    // regex-replace forms are assumed by static checkers to target a single
    // unescape stage and get flagged as incomplete or double-escaped):
    out = out.replace(/[\\\"`$\n\t\r]/g, (ch) => {
      if (ch === '\\') return '\\\\\\\\';
      if (ch === '\n') return '\\n';
      if (ch === '\t') return '\\t';
      if (ch === '\r') return '\\r';
      return `\\${ch}`;
    });
    return `"${out}"`;
  };
  const iconString = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/\s/g, '\\s');
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=DevBar',
    'Comment=Menu bar launcher for local development services',
    `Exec=${quote(executable)}`,
  ];
  if (icon) lines.push(`Icon=${iconString(icon)}`);
  lines.push('Terminal=false', 'Categories=Development;Utility;');
  return `${lines.join('\n')}\n`;
}

/**
 * %APPDATA%\Microsoft\Windows\Start Menu\Programs — where per-user Start
 * Menu shortcuts live.
 */
export function startMenuProgramsDir(): string {
  const appData = absoluteEnvDir(
    'APPDATA',
    path.join(os.homedir(), 'AppData', 'Roaming'),
  );
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

/** The Start Menu shortcut for this install. */
export function startMenuLnkPath(): string {
  return path.join(startMenuProgramsDir(), 'DevBar.lnk');
}

/**
 * PowerShell command that writes the .lnk via WScript.Shell — the only
 * dependency-free way to create a Windows shortcut. Single-quoted strings
 * with '' escaping (PowerShell's single-quote rule).
 */
export function lnkCommand(
  lnkPath: string,
  target: string,
  workingDir: string,
  icon?: string | null,
): string {
  const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const iconLine = icon ? `; $l.IconLocation = ${q(`${icon},0`)}` : '';
  return (
    `$s = New-Object -ComObject WScript.Shell; ` +
    `$l = $s.CreateShortcut(${q(lnkPath)}); ` +
    `$l.TargetPath = ${q(target)}; ` +
    `$l.WorkingDirectory = ${q(workingDir)}` +
    iconLine +
    `; $l.Save()`
  );
}

/**
 * Best-effort icon lookup next to an unpacked app. electron-builder puts
 * the platform icon under resources/ (icon.png on Linux, icon.ico on
 * Windows), but this scans a couple of levels instead of assuming — the
 * layout is the builder's and a missing icon must never break an install.
 */
export function findAppIcon(
  installDir: string,
  extension: '.png' | '.ico',
): string | null {
  const candidates = [
    path.join(installDir, 'resources', `icon${extension}`),
    path.join(installDir, `icon${extension}`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Icon sources that ship with the repo (install-local always runs from a
 * checkout). The electron-builder `dir` target does not reliably place an
 * icon inside the unpacked app, so when none is found next to the
 * installed copy, one is copied in — referencing a file that travels with
 * the install instead of a path into the checkout (which may move).
 */
export function pickRepoIcon(
  repoRoot: string,
  extension: '.png' | '.ico',
): string | null {
  if (extension === '.ico') {
    const candidate = path.join(repoRoot, 'assets', 'icon.ico');
    return fs.existsSync(candidate) ? candidate : null;
  }
  // Largest first: desktop app menus want ~256px and scale down cleanly.
  for (const size of [256, 128, 64, 48, 32, 16]) {
    const candidate = path.join(
      repoRoot,
      'buildResources',
      'icons',
      `${size}.png`,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * An icon the launcher can reference: one already shipped inside the
 * installed app, or a copy of the repo's icon placed at
 * <installDir>/resources/icon.<ext>. Null when no source exists.
 */
export function ensureInstallIcon(
  installDir: string,
  extension: '.png' | '.ico',
  repoRoot: string,
): string | null {
  const existing = findAppIcon(installDir, extension);
  if (existing) return existing;
  const source = pickRepoIcon(repoRoot, extension);
  if (!source) return null;
  const target = path.join(installDir, 'resources', `icon${extension}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

/** Where install-local puts the app on the given platform. */
export function defaultInstallDir(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const localAppData = absoluteEnvDir(
      'LOCALAPPDATA',
      path.join(os.homedir(), 'AppData', 'Local'),
    );
    return path.join(localAppData, 'Programs', 'DevBar');
  }
  return path.join(os.homedir(), '.local', 'share', 'DevBar');
}

/**
 * Everything the registration touches, injected. The tests must never write
 * into the real ~/.local/share/applications or Start Menu, and the win32
 * branch has to be exercisable from a POSIX host.
 */
export interface RegisterLauncherOptions {
  platform: NodeJS.Platform;
  /** Where install-local put the app. */
  installDir: string;
  /** Checkout root: the fallback icon source. */
  repoRoot: string;
  /** Destination .desktop file (linux). */
  desktopFile: string;
  /** Destination .lnk file (win32). */
  lnkPath: string;
  spawn: LauncherSpawn;
  report: LauncherReporter;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best effort: a missing or uncopyable icon warns, it never fails. */
function launcherIcon(
  installDir: string,
  extension: '.png' | '.ico',
  repoRoot: string,
  report: LauncherReporter,
): string | null {
  try {
    return ensureInstallIcon(installDir, extension, repoRoot);
  } catch (error) {
    report.warn(`icon not installed (${errorMessage(error)})`);
    return null;
  }
}

function registerDesktopEntry(
  { installDir, repoRoot, desktopFile, spawn, report }: RegisterLauncherOptions,
  appPath: string,
): void {
  // App-menu entry: what makes the install show up in the GNOME/KDE app
  // grid, same as the .desktop entry the .deb ships.
  report.step('Registering in the app menu…');
  const icon = launcherIcon(installDir, '.png', repoRoot, report);
  if (!icon)
    report.warn('no icon available — the launcher entry will have none');
  try {
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.writeFileSync(desktopFile, renderDesktopEntry(appPath, icon));
    // Some desktops cache the menu database; a refresh is best effort.
    tryQuiet(spawn, 'update-desktop-database', [path.dirname(desktopFile)]);
    report.ok(`App menu entry: ${desktopFile}`);
  } catch (error) {
    report.warn(
      `App menu entry not created (${errorMessage(
        error,
      )}) — launch it with: ${appPath}`,
    );
  }
}

function registerStartMenuShortcut(
  { installDir, repoRoot, lnkPath, spawn, report }: RegisterLauncherOptions,
  appPath: string,
): void {
  // Start Menu shortcut — the Windows equivalent of the app-menu entry.
  report.step('Registering in the Start Menu…');
  try {
    fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
    const icon = launcherIcon(installDir, '.ico', repoRoot, report);
    const result = spawn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      lnkCommand(lnkPath, appPath, installDir, icon),
    ]);
    if (result.error) throw result.error;
    if (result.status === 0) {
      report.ok(`Start Menu shortcut: ${lnkPath}`);
    } else {
      report.warn(
        `Start Menu shortcut not created (powershell exit ${result.status}) — pin DevBar.exe from the Start Menu instead.`,
      );
    }
  } catch (error) {
    report.warn(`Start Menu shortcut not created (${errorMessage(error)}).`);
  }
}

/**
 * Register an installed copy in the OS launcher UI. Best effort by design:
 * the install itself is already done, so a broken launcher only warns.
 */
export function registerLauncher(options: RegisterLauncherOptions): void {
  const { platform, installDir, report } = options;
  const executable = platform === 'win32' ? 'DevBar.exe' : 'devbar';
  const appPath = path.join(installDir, executable);
  if (!fs.existsSync(appPath)) {
    // Nothing installed yet (or a different user ran the install): a
    // warning, not an error — platform.ts runs us right after install-local.
    report.warn(`no DevBar install at ${installDir} — nothing to register`);
    return;
  }
  if (platform === 'linux') registerDesktopEntry(options, appPath);
  else if (platform === 'win32') registerStartMenuShortcut(options, appPath);
}

function main(): void {
  const platform = process.platform;
  registerLauncher({
    platform,
    installDir: defaultInstallDir(platform),
    repoRoot: ROOT,
    desktopFile: desktopLauncherPath(),
    lnkPath: startMenuLnkPath(),
    spawn: spawnQuiet,
    report: consoleReporter,
  });
}

// Direct execution only (platform.ts spawns us); importing us for the pure
// functions (tests) must not run the installer-side effects.
if (isEntrypoint(import.meta.url)) main();
