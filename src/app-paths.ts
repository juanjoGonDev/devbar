import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A base directory taken from the environment, honored ONLY when it is a
 * non-empty ABSOLUTE path. `||` alone rejects `''` but still accepts
 * `"relative/path"` or `"   "`, and the XDG Base Directory Specification
 * requires absolute values. This matters beyond tidiness: appHome() feeds
 * the config store, the log dir, the update staging dir AND the directory
 * the generated swap script is written to and then RUN from — a relative
 * value would resolve against whatever CWD the app inherited. Same rule
 * (and same reasoning) as absoluteEnvDir in scripts/lib/script-runtime.ts.
 *
 * On win32 `path.isAbsolute` is `path.win32.isAbsolute`, which is exactly
 * the semantics %APPDATA% needs.
 */
function absoluteEnvDir(name: string, fallback: string): string {
  const value = (process.env[name] ?? '').trim();
  return value !== '' && path.isAbsolute(value) ? value : fallback;
}

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
      absoluteEnvDir('APPDATA', path.join(home, 'AppData', 'Roaming')),
      'DevBar',
    );
  return path.join(
    absoluteEnvDir('XDG_CONFIG_HOME', path.join(home, '.config')),
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

/**
 * Where pre-"DevBar"-pin packaged builds stored their config on Linux:
 * Electron resolved the XDG config dir from the package.json name
 * ("devbar", lowercase) — so upgrading users' real config lives in
 * `$XDG_CONFIG_HOME/devbar/config.json` while the store now opens
 * `$XDG_CONFIG_HOME/DevBar/config.json`.
 */
export function legacyLinuxConfigFile(
  home: string,
  xdgConfigHome: string | undefined,
): string {
  const xdg = xdgConfigHome || path.join(home, '.config');
  return path.join(xdg, 'devbar', 'config.json');
}

/**
 * Move the legacy Linux config into the new store dir so the v1→v4
 * migrations run on the user's real data. Must run BEFORE the Store is
 * constructed (the Store creates the file on first write, which would
 * make the legacy file invisible to them). Never overwrites an existing
 * target; best effort — a failure yields 'failed' and the new empty
 * store is used rather than crashing startup.
 */
export function migrateLegacyLinuxStore(
  newStoreDir: string,
  home: string,
  xdgConfigHome: string | undefined,
): 'moved' | 'skipped' | 'failed' {
  const legacy = legacyLinuxConfigFile(home, xdgConfigHome);
  const target = path.join(newStoreDir, 'config.json');
  if (!fs.existsSync(legacy) || fs.existsSync(target)) return 'skipped';
  try {
    fs.mkdirSync(newStoreDir, { recursive: true });
  } catch {
    return 'failed';
  }
  try {
    // link + unlink, NOT rename: rename(2) silently REPLACES an existing
    // target, which would destroy config written by a newer instance that
    // created it after the existsSync check above. link(2) fails EEXIST
    // atomically instead, so the same "an existing target must WIN"
    // invariant the copy fallback enforces holds on the primary path too.
    // It is equally atomic where the filesystem allows it: after the link
    // both names refer to one inode, so the unlink below cannot lose data.
    fs.linkSync(legacy, target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'skipped';
    // Everything else falls through: EXDEV across devices, and
    // EPERM/ENOSYS/EMLINK on filesystems with no hard links. Copy
    // EXCLUSIVELY, for the same reason link is used above.
    try {
      fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL);
    } catch (copyError: unknown) {
      if ((copyError as NodeJS.ErrnoException).code === 'EEXIST')
        return 'skipped';
      return 'failed';
    }
  }
  try {
    fs.unlinkSync(legacy);
  } catch {
    // Deletion failure is not a migration failure: the new location now
    // wins, and a stale legacy copy that cannot be removed is inert (the
    // skip check above sees the target first).
    console.warn(
      `[app-paths] legacy config migrated to ${target} but the old file at ` +
        `${legacy} could not be removed — delete it manually if you see ` +
        `unexpected config behavior.`,
    );
  }
  return 'moved';
}
