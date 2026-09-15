/**
 * OS launcher creation for scripts/install-local.ts — the piece that makes a
 * locally installed DevBar discoverable in the OS UI the way a packaged
 * install is (the .deb ships its own .desktop entry, the NSIS installer
 * creates its own shortcuts; an unpacked copy is invisible to the app menu
 * and the Start Menu without these).
 *
 * Pure helpers, no side effects: install-local.ts runs what is rendered
 * here, and the tests exercise the rendering without touching a real
 * desktop.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
