import { LOGIN_ARG } from '../autostart.js';

/**
 * The two OS-registration concerns: telling the system to start DevBar at
 * login, and asking it afterwards whether THIS launch was that login one.
 *
 * The signal is per-platform and each platform gets it wrong differently,
 * which is why the branch is worth isolating: macOS answers natively, while
 * Windows and Linux only know because their autostart entry passes `--login`.
 */

export interface AutostartHost {
  /** Dev runs are a no-op: the entry would point at Electron's own binary. */
  isPackaged: boolean;
  isMac: boolean;
  isWin: boolean;
  setLoginItemSettings: (settings: {
    openAtLogin: boolean;
    openAsHidden?: boolean;
    args?: string[];
  }) => void;
  setLinuxAutostart: (execPath: string, enabled: boolean) => void;
  /**
   * A RUNNING AppImage's `process.execPath` is the ephemeral squashfs mount
   * (/tmp/.mount_XXX/…) — a .desktop entry pointing there would reference a
   * path that dies with the app. The installed path resolves the persistent
   * image file; it is null for .deb installs, where execPath IS the binary.
   */
  installedAppPath: () => string | null;
  execPath: string;
}

export function applyAutostart(host: AutostartHost, enabled: boolean): void {
  if (!host.isPackaged) return;
  try {
    if (host.isMac) {
      host.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
    } else if (host.isWin) {
      // The --login argument is the boot signal on Windows (see autostart.ts).
      host.setLoginItemSettings({
        openAtLogin: !!enabled,
        args: enabled ? [LOGIN_ARG] : [],
      });
    } else {
      host.setLinuxAutostart(
        host.installedAppPath() ?? host.execPath,
        !!enabled,
      );
    }
  } catch (err) {
    console.error('Failed to set login item:', err);
  }
}

export interface LoginSignalHost {
  isMac: boolean;
  /** macOS answers natively. */
  loginItemWasOpenedAtLogin: () => boolean;
  /** Windows/Linux answer through the `--login` argument their entry passes. */
  openedAtLoginFromArgv: () => boolean;
}

export function wasOpenedAtLogin(host: LoginSignalHost): boolean {
  return host.isMac
    ? host.loginItemWasOpenedAtLogin()
    : host.openedAtLoginFromArgv();
}
