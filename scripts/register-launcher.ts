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
 * must stay self-contained (node: builtins only, no relative imports).
 *
 * Usage: node --experimental-strip-types scripts/register-launcher.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const platform = process.platform;
const step = (message: string): void => console.log(`→ ${message}`);
const ok = (message: string): void => console.log(`✓ ${message}`);
const warn = (message: string): void => console.log(`! ${message}`);

function tryQuiet(cmd: string, args: string[]): void {
  try {
    spawnSync(cmd, args, { stdio: 'ignore' });
    /* best effort */
  } catch {
    /* binary missing is an expected outcome */
  }
}

export const DESKTOP_FILE_NAME = 'devbar.desktop';

/**
 * XDG user applications dir: $XDG_DATA_HOME/applications when set, else
 * ~/.local/share/applications.
 */
export function desktopApplicationsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'applications');
}

/** The .desktop file that registers DevBar in the app menu. */
export function desktopLauncherPath(): string {
  return path.join(desktopApplicationsDir(), DESKTOP_FILE_NAME);
}

/**
 * XDG .desktop content for an installed copy. Exec points at the exact
 * executable of this install; the icon (when one was found next to the
 * app) is an absolute path — legal for user-local entries. Paths with
 * whitespace are quoted per the Desktop Entry spec (Exec field).
 */
export function renderDesktopEntry(
  executable: string,
  icon?: string | null,
): string {
  const quote = (value: string): string =>
    /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=DevBar',
    'Comment=Menu bar launcher for local development services',
    `Exec=${quote(executable)}`,
  ];
  if (icon) lines.push(`Icon=${quote(icon)}`);
  lines.push('Terminal=false', 'Categories=Development;Utility;');
  return `${lines.join('\n')}\n`;
}

/**
 * %APPDATA%\Microsoft\Windows\Start Menu\Programs — where per-user Start
 * Menu shortcuts live.
 */
export function startMenuProgramsDir(): string {
  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
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

/** Where install-local puts the app on this platform. */
function installDir(): string {
  if (platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'DevBar');
  }
  return path.join(os.homedir(), '.local', 'share', 'DevBar');
}

function main(): void {
  const dir = installDir();
  const executable = platform === 'win32' ? 'DevBar.exe' : 'devbar';
  const appPath = path.join(dir, executable);
  if (!fs.existsSync(appPath)) {
    // Nothing installed yet (or a different user ran the install): a
    // warning, not an error — platform.ts runs us right after install-local.
    warn(`no DevBar install at ${dir} — nothing to register`);
    return;
  }

  if (platform === 'linux') {
    // App-menu entry: what makes the install show up in the GNOME/KDE app
    // grid, same as the .desktop entry the .deb ships.
    step('Registering in the app menu…');
    const desktopFile = desktopLauncherPath();
    try {
      const icon = findAppIcon(dir, '.png');
      fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
      fs.writeFileSync(desktopFile, renderDesktopEntry(appPath, icon));
      // Some desktops cache the menu database; a refresh is best effort.
      tryQuiet('update-desktop-database', [path.dirname(desktopFile)]);
      ok(`App menu entry: ${desktopFile}`);
    } catch (error) {
      warn(
        `App menu entry not created (${
          error instanceof Error ? error.message : String(error)
        }) — launch it with: ${appPath}`,
      );
    }
  } else if (platform === 'win32') {
    // Start Menu shortcut — the Windows equivalent of the app-menu entry.
    step('Registering in the Start Menu…');
    const lnk = startMenuLnkPath();
    try {
      fs.mkdirSync(path.dirname(lnk), { recursive: true });
      const icon = findAppIcon(dir, '.ico');
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          lnkCommand(lnk, appPath, dir, icon),
        ],
        { stdio: 'ignore' },
      );
      if (result.error) throw result.error;
      if (result.status === 0) {
        ok(`Start Menu shortcut: ${lnk}`);
      } else {
        warn(
          `Start Menu shortcut not created (powershell exit ${result.status}) — pin DevBar.exe from the Start Menu instead.`,
        );
      }
    } catch (error) {
      warn(
        `Start Menu shortcut not created (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
    }
  }
}

// Direct execution only (platform.ts spawns us); importing us for the pure
// functions (tests) must not run the installer-side effects.
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;
if (invokedDirectly) main();
