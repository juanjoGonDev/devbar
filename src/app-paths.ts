import { app } from 'electron';
import path from 'node:path';

/**
 * Per-OS app-data home for PACKAGED builds, pinned to the "DevBar" folder:
 *   macOS   ~/Library/Application Support/DevBar
 *   Windows %APPDATA%\DevBar
 *   Linux   $XDG_CONFIG_HOME/DevBar (default ~/.config)
 *
 * Why explicit instead of `app.getPath('userData')`: on Linux Electron
 * resolves the XDG config directory from the package.json name ("devbar")
 * at process start — before main.js runs — so the `app.name` pin in
 * main.ts can never move it. Pinning the folder explicitly keeps config,
 * logs and update staging under one per-OS "DevBar" folder. (On Windows the
 * pin does move the default paths and on macOS the app bundle already reads
 * "DevBar" — the explicit pin simply makes all three OSes say the same
 * thing.)
 *
 * Unpackaged (dev mode) returns undefined: Electron's defaults apply, so
 * existing dev stores, logs and caches are not orphaned.
 */
export function packagedAppHome(): string | undefined {
  if (!app.isPackaged) return undefined;
  const home = app.getPath('home');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'DevBar');
  if (process.platform === 'win32')
    return path.join(
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'DevBar',
    );
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'DevBar',
  );
}

/**
 * The packaged pin applied to Electron's userData: the "DevBar" folder in
 * packaged builds, Electron's default userData in dev mode.
 */
export function appHome(): string {
  return packagedAppHome() ?? app.getPath('userData');
}
