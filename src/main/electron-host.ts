import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type Display,
  type MessageBoxOptions,
  type NativeImage,
  type OpenDialogOptions,
  type Rectangle,
  type SaveDialogOptions,
  type WebContents,
} from 'electron';
import { setLinuxAutostart, wasOpenedAtLoginFromArgv } from '../autostart.js';
import { installedAppPath } from '../self-update.js';
import { isLinux, isMac, isWin } from '../platform.js';
import { appHome } from '../app-paths.js';
import { resolvedThemeIsDark, themeWindowBackground } from './theme.js';
import { prepareIssueReport } from '../report-issue.js';
import {
  applyAutostart as applyAutostartTo,
  wasOpenedAtLogin as resolveWasOpenedAtLogin,
} from './os-integration.js';
import type { ThemePreference } from '../domain-types.js';

/**
 * Everything the rest of the main process needs from Electron and the file
 * system, as one injectable surface. Nothing here decides anything: each member
 * is the thinnest adapter that lets a `src/main/*` module stay testable, and
 * keeping them together is what makes "what does this process touch outside
 * itself" answerable by reading one file.
 */

export interface ElectronHostOptions {
  /** Directory of the running `main.js`, for resolving bundled assets. */
  dirname: string;
  themePreference: () => ThemePreference;
  /** Config window, else the tray popover, else whatever has focus. */
  dialogOwner: () => BrowserWindow | null;
}

/** Packaged Windows/Linux keep logs beside config under the pinned
 *  "DevBar" folder; everywhere else Electron's own logs dir wins. */
function logFilePath(): string {
  return path.join(
    app.isPackaged && !isMac
      ? path.join(appHome(), 'logs')
      : app.getPath('logs'),
    'app.log',
  );
}

export function createElectronHost(options: ElectronHostOptions) {
  const { dirname } = options;
  const rendererFile = (name: string): string =>
    path.join(dirname, '..', 'renderer', name);
  const assetFile = (name: string): string =>
    path.join(dirname, '..', 'assets', name);

  /**
   * Display the user is actually looking at: the focused window's screen, else
   * the screen under the cursor. Using the PRIMARY display made banners always
   * pop on the built-in screen and, worse, yanked the active Space away from a
   * config window living on a second display.
   */
  const activeDisplay = (): Display => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused && !focused.isDestroyed()
      ? screen.getDisplayMatching(focused.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  };

  let confirmLogo: string | null = null;

  return {
    rendererFile,
    assetFile,
    preloadPath: path.join(dirname, 'preload.cjs'),
    /**
     * Whether the development-only simulation panel shipped with this build.
     * One source of truth: the files are either in the bundle or they are not.
     */
    devPanelAvailable: fs.existsSync(path.join(dirname, 'dev', 'dev-ipc.js')),
    /**
     * Packaged Windows/Linux builds keep logs beside config and updates under
     * the pinned "DevBar" folder; everywhere else Electron's own logs dir wins.
     */
    logFilePath: logFilePath,
    updatesDir: (): string => path.join(appHome(), 'updates'),
    downloadsDir: (): string => app.getPath('downloads'),

    createWindow: (opts: BrowserWindowConstructorOptions): BrowserWindow =>
      new BrowserWindow(opts),
    activeDisplay,
    workArea: (): Rectangle => activeDisplay().workArea,
    workAreaHeight: (bounds: Rectangle): number =>
      screen.getDisplayMatching(bounds).workAreaSize.height,
    displayMatching: (rect: Rectangle) => screen.getDisplayMatching(rect),

    /**
     * Window icon for dev mode: `electron .` runs on the Electron shell, so the
     * taskbar/titlebar would otherwise show Electron's default icon. Packaged
     * Windows builds already pick it up from the .exe icon — same design.
     */
    windowIcon: (): NativeImage => {
      try {
        const file = assetFile(isWin ? 'icon.ico' : 'icon.png');
        if (!fs.existsSync(file)) return nativeImage.createEmpty();
        const image = nativeImage.createFromPath(file);
        return image.isEmpty() ? nativeImage.createEmpty() : image;
      } catch {
        return nativeImage.createEmpty();
      }
    },

    background: (): string =>
      themeWindowBackground(
        resolvedThemeIsDark(
          options.themePreference(),
          nativeTheme.shouldUseDarkColors,
        ),
      ),
    onThemeUpdated: (listener: () => void): void => {
      nativeTheme.on('updated', listener);
    },

    /** Data-URL logo for the confirm modal; '' hides the <img> gracefully. */
    confirmLogo: (): string => {
      if (confirmLogo !== null) return confirmLogo;
      try {
        confirmLogo = `data:image/png;base64,${fs
          .readFileSync(assetFile('icon.png'))
          .toString('base64')}`;
      } catch (e) {
        confirmLogo = '';
      }
      return confirmLogo;
    },

    messageBox: (opts: MessageBoxOptions) => {
      const owner = options.dialogOwner();
      return owner
        ? dialog.showMessageBox(owner, opts)
        : dialog.showMessageBox(opts);
    },
    messageBoxForSender: (sender: unknown, opts: MessageBoxOptions) => {
      const win = BrowserWindow.fromWebContents(sender as WebContents);
      return win
        ? dialog.showMessageBox(win, opts)
        : dialog.showMessageBox(opts);
    },
    openDialog: (opts: OpenDialogOptions) => {
      const owner = options.dialogOwner();
      return owner
        ? dialog.showOpenDialog(owner, opts)
        : dialog.showOpenDialog(opts);
    },
    saveDialog: (opts: SaveDialogOptions) => {
      const owner = options.dialogOwner();
      return owner
        ? dialog.showSaveDialog(owner, opts)
        : dialog.showSaveDialog(opts);
    },
    // The folder picker deliberately owns no window: it is opened from whatever
    // surface the user is on, and an owner would make it modal to the wrong one.
    folderDialog: (opts: OpenDialogOptions) => dialog.showOpenDialog(opts),

    files: {
      readText: (filePath: string): string => fs.readFileSync(filePath, 'utf8'),
      writeText: (filePath: string, contents: string): void =>
        fs.writeFileSync(filePath, contents, 'utf8'),
    },
    removeFile: (target: string): void => fs.rmSync(target, { force: true }),
    writeFile: (target: string, contents: string): void =>
      fs.writeFileSync(target, contents),
    updaterFs: {
      mkdirSync: (dir: string): void => {
        fs.mkdirSync(dir, { recursive: true });
      },
      rmSync: (
        target: string,
        opts: { recursive?: boolean; force: boolean },
      ): void => fs.rmSync(target, opts),
      readdirSync: (dir: string): string[] => fs.readdirSync(dir),
      isDirectory: (target: string): boolean =>
        fs.statSync(target).isDirectory(),
      readInstalledPlist: (bundle: string): string | null => {
        try {
          return fs.readFileSync(
            path.join(bundle, 'Contents', 'Info.plist'),
            'utf8',
          );
        } catch {
          return null;
        }
      },
    },

    applyAutostart: (enabled: boolean): void =>
      applyAutostartTo(
        {
          isPackaged: app.isPackaged,
          isMac,
          isWin,
          setLoginItemSettings: (settings) =>
            app.setLoginItemSettings(settings),
          setLinuxAutostart,
          installedAppPath,
          execPath: process.execPath,
        },
        enabled,
      ),
    wasOpenedAtLogin: (): boolean =>
      resolveWasOpenedAtLogin({
        isMac,
        loginItemWasOpenedAtLogin: () =>
          app.getLoginItemSettings().wasOpenedAtLogin,
        openedAtLoginFromArgv: wasOpenedAtLoginFromArgv,
      }),
    spawnDetached: (command: string, args: string[]) =>
      spawn(command, args, { detached: true, stdio: 'ignore' }),

    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    isMac,
    isLinux,
    /** XDG_CURRENT_DESKTOP, which names the Linux settings tool to launch. */
    desktop: process.env.XDG_CURRENT_DESKTOP ?? '',
    sessionType: process.env.XDG_SESSION_TYPE ?? 'desconocida',
    appVersion: (): string => app.getVersion(),
    /**
     * One-click bug report: markdown (version, platform, app.log tail) to
     * the clipboard ALWAYS, then GitHub's new-issue form — with the body
     * pre-filled when it fits the URL, title-only otherwise. Pure logic in
     * src/report-issue.ts; this only reads the log and touches the OS.
     */
    reportIssue: (): { url: string; bodyIncluded: boolean } => {
      let tail = '';
      try {
        tail = fs.readFileSync(logFilePath(), 'utf8');
      } catch {
        // No log yet (fresh install, clean app): report without one.
      }
      const report = prepareIssueReport(
        {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron ?? '',
          node: process.versions.node ?? '',
          osRelease: os.release(),
        },
        tail,
      );
      clipboard.writeText(report.clipboardText);
      return { url: report.url, bodyIncluded: report.bodyIncluded };
    },
    appQuit: (): void => app.quit(),
    appExit: (code: number): void => app.exit(code),
    /** Fire-and-forget; the https-only guard lives in the IPC handler. */
    openExternal: (url: string): void => void shell.openExternal(url),
    openExternalAsync: (url: string): Promise<void> => shell.openExternal(url),
    openPath: (target: string): Promise<string> => shell.openPath(target),
  };
}
