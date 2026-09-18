import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  NativeImage,
} from 'electron';
import { adaptiveSize, type Rect } from './window-geometry.js';
import type { WindowRegistry } from './renderer-bus.js';

/**
 * The three ordinary app windows: configuration, a command's silenced-patterns
 * editor, and the pre-script confirmation modal.
 *
 * None of them is `setVisibleOnAllWorkspaces` except the modal: as an accessory
 * (menubar) app, a can-join-all-spaces window shown on a SECONDARY display
 * makes macOS minimize the other windows there. Regular per-space behaviour
 * avoids it; the modal is worth the trade because it blocks a start.
 */

export interface AppWindowsDeps {
  registry: WindowRegistry;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  rendererFile: (name: string) => string;
  preloadPath: string;
  windowIcon: () => NativeImage;
  background: () => string;
  workArea: () => Rect;
  attachConsole: (win: BrowserWindow, label: string) => void;
  onWindowsChanged: () => void;
  isMac: boolean;
  platformLabel: () => string;
  /** The command's display name, or null when it no longer exists. */
  commandName: (groupId: string, commandId: string) => string | null;
  /** A modal closed without a decision => implicit cancel. */
  onConfirmWindowClosed: (token: string) => void;
}

export interface AppWindows {
  ensureConfigWindow: (options?: { goto?: string }) => void;
  ensureSilencedWindow: (
    groupId: string,
    commandId: string,
  ) => BrowserWindow | null;
  ensurePrescriptConfirmWindow: (token: string) => BrowserWindow;
  /** Drop the config window's unsaved-changes veto (shutdown, explicit close). */
  releaseConfigCloseGuard: () => void;
  /** The renderer answered the dirty-close prompt: really close now. */
  confirmCloseConfig: () => void;
}

export function createAppWindows(deps: AppWindowsDeps): AppWindows {
  const { registry } = deps;
  let forceCloseConfig = false;

  function ensureConfigWindow({ goto }: { goto?: string } = {}): void {
    const existing = registry.config as BrowserWindow | null;
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      if (goto) existing.webContents.send('config:goto', goto);
      return;
    }
    const size = adaptiveSize(deps.workArea(), 820, 640);
    forceCloseConfig = false;
    const win = deps.createWindow({
      width: size.width,
      height: size.height,
      x: size.x,
      y: size.y,
      minWidth: 460,
      minHeight: 380,
      title: 'DevBar — Configuración',
      icon: deps.windowIcon(),
      // macOS: frameless-ish hiddenInset with vibrancy. Elsewhere: a normal
      // titled window (vibrancy/traffic-light positions don't exist).
      ...(deps.isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 14, y: 16 },
            vibrancy: 'sidebar' as const,
            visualEffectState: 'active' as const,
            backgroundColor: '#00000000',
          }
        : { backgroundColor: deps.background() }),
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    registry.config = win;
    win.setMenuBarVisibility(false);
    void win.loadFile(deps.rendererFile('config.html'));
    // A fresh window can't receive the deep-link until its renderer has loaded.
    // Without this, the very first open (or any open after the window was
    // closed) never navigates — only reused windows did.
    if (goto) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('config:goto', goto);
      });
    }
    win.on('close', (event) => {
      if (forceCloseConfig) return;
      event.preventDefault();
      win.webContents.send('config:closeRequested');
    });
    win.on('closed', () => {
      forceCloseConfig = false;
      if (registry.config === win) registry.config = null;
      deps.onWindowsChanged();
    });
    deps.attachConsole(win, 'config');
    deps.onWindowsChanged();
  }

  return {
    ensureConfigWindow,

    releaseConfigCloseGuard(): void {
      forceCloseConfig = true;
    },

    confirmCloseConfig(): void {
      const win = registry.config as BrowserWindow | null;
      if (!win || win.isDestroyed()) return;
      forceCloseConfig = true;
      win.close();
    },

    ensureSilencedWindow(groupId, commandId): BrowserWindow | null {
      const key = `${groupId}:${commandId}`;
      const existing = registry.silenced.get(key) as BrowserWindow | undefined;
      if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return existing;
      }
      const name = deps.commandName(groupId, commandId);
      if (name === null) return null;
      const win = deps.createWindow({
        width: 480,
        height: 520,
        minWidth: 360,
        minHeight: 320,
        title: `Silenciados — ${name}`,
        backgroundColor: deps.background(),
        ...(deps.isMac
          ? {
              titleBarStyle: 'hiddenInset' as const,
              trafficLightPosition: { x: 12, y: 14 },
            }
          : {}),
        webPreferences: {
          preload: deps.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.setMenuBarVisibility(false);
      void win.loadFile(deps.rendererFile('silenced.html'), {
        query: { groupId, commandId, platform: deps.platformLabel() },
      });
      win.on('closed', () => {
        registry.silenced.delete(key);
        deps.onWindowsChanged();
      });
      registry.silenced.set(key, win);
      deps.attachConsole(win, `silenced:${key}`);
      deps.onWindowsChanged();
      return win;
    },

    ensurePrescriptConfirmWindow(token): BrowserWindow {
      const win = deps.createWindow({
        width: 380,
        height: 300, // fixed for v1; CSS ellipsis/wrap handles long commands
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        center: true,
        fullscreenable: false,
        minimizable: false,
        maximizable: false,
        show: false, // show on ready-to-show to avoid a white flash
        backgroundColor: deps.background(),
        webPreferences: {
          preload: deps.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.setMenuBarVisibility(false);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      void win.loadFile(deps.rendererFile('prescript-confirm.html'), {
        query: { token },
      });
      win.once('ready-to-show', () => {
        win.show();
        win.focus();
      });
      win.on('closed', () => {
        // OS-level / force close without a decision => implicit cancel.
        deps.onConfirmWindowClosed(token);
        registry.prescriptConfirm.delete(token);
        deps.onWindowsChanged();
      });
      registry.prescriptConfirm.set(token, win);
      deps.attachConsole(win, `prescript-confirm:${token}`);
      deps.onWindowsChanged();
      return win;
    },
  };
}
