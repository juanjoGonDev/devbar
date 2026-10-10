import type { BrowserWindow, Menu, NativeImage, Rectangle } from 'electron';
import type { Menubar, menubar } from 'menubar';
import { parseProcessId } from '../compound-id.js';
import { patchLinuxTrayPositioning } from './tray.js';
import { patchPinnedPositioning } from './pinned-popover.js';
import {
  TRAY_POPOVER_MIN_HEIGHT,
  TRAY_POPOVER_MIN_WIDTH,
  TRAY_POPOVER_WIDTH,
} from './pinned-popover-geometry.js';
import type { LogEntry } from '../domain-types.js';

/**
 * The two pieces of app startup that are pure event wiring: subscribing to the
 * process manager and the repo watcher, and standing the menubar up once
 * Electron is ready.
 *
 * Both are here rather than in `main.ts` because the ORDER and the guards
 * matter — a snapshot written during shutdown overwrites the authoritative one,
 * and an individual pre-script exit must not toast over the pipeline's own
 * result — and neither is observable without driving the events by hand.
 */

interface ProcessEventSource {
  on(event: 'change', listener: () => void): unknown;
  on(
    event: 'log',
    listener: (payload: { id: string; entry: LogEntry }) => void,
  ): unknown;
  on(
    event: 'action:done',
    listener: (payload: {
      processId: string;
      code: number | null;
      group: { name: string } | null;
      target: { name: string } | null;
    }) => void,
  ): unknown;
}

export interface ProcessEventDeps {
  processManager: ProcessEventSource;
  repoWatcher: {
    on(event: 'change', listener: (path: string) => void): unknown;
  };
  broadcast: () => void;
  toast: (kind: string, message: string) => void;
  broadcastLog: (payload: { id: string; entry: LogEntry }) => void;
  branchesChanged: (repoPath: string) => void;
  /** True exactly once per scheduled action, on its `action:done`. */
  claimScheduledAction: (processId: string) => boolean;
  showCompletionNotification: (title: string, body: string) => void;
  /** Tracks the running set, or null before the tracker exists / in smoke mode. */
  trackResume: () => void;
}

export function wireProcessEvents(deps: ProcessEventDeps): void {
  deps.processManager.on('change', () => {
    deps.broadcast();
    deps.trackResume();
  });
  deps.processManager.on('log', (payload) => deps.broadcastLog(payload));
  deps.processManager.on(
    'action:done',
    ({ processId, code, group, target }) => {
      // Pre-script exits are handled by the pipeline runner, which reports at
      // the PIPELINE level; an individual script exit must not toast on its
      // own. The kind comes from the SHARED id parser, never a prefix test of
      // its own.
      if (parseProcessId(processId).kind === 'prescript') {
        deps.broadcast();
        return;
      }
      const name = `${group ? group.name : '?'} · ${target ? target.name : '?'}`;
      deps.toast(code === 0 ? 'ok' : 'error', `${name} exited ${code}`);
      // Scheduled actions run unattended — notify natively when they finish.
      if (deps.claimScheduledAction(processId))
        deps.showCompletionNotification(
          'DevBar — acción programada',
          code === 0
            ? `${name}: completada`
            : `${name}: falló (código ${code})`,
        );
      deps.broadcast();
    },
  );
  deps.repoWatcher.on('change', (repoPath) => deps.branchesChanged(repoPath));
}

type MenubarOptions = NonNullable<Parameters<typeof menubar>[0]>;

export interface MenubarSetupDeps {
  createMenubar: (options: MenubarOptions) => Menubar;
  trayIndexUrl: string;
  preloadPath: string;
  defaultIcon: () => NativeImage;
  windowIcon: () => NativeImage;
  background: () => string;
  isMac: boolean;
  isLinux: boolean;
  sessionType: string;
  /**
   * The `[display]` line for app.log (backend + work area), read once the
   * tray is up because it needs the screen; null off Linux.
   */
  displayLine: () => string | null;
  attachTray: (bar: Menubar) => void;
  attachConsole: (win: BrowserWindow, label: string) => void;
  displayMatching: (rect: Rectangle) => {
    workArea: Rectangle;
    bounds: Rectangle;
  };
  buildContextMenu: () => Menu;
  broadcast: () => void;
  refreshTrayIcon: () => void;
  invalidateTrayIconCache: () => void;
  repaintWindows: () => void;
  onThemeUpdated: (listener: () => void) => void;
  /** Boot auto-start, the schedule loop and the update check, once the tray is up. */
  scheduleBootWork: () => void;
  /** The popover's pinned mode, fed menubar's window and show events. */
  pinnedPopover: {
    attach: (win: BrowserWindow) => void;
    beforeShow: () => void;
    afterShow: () => void;
    position: () => { x: number; y: number } | null;
  };
}

export function setupMenubar(deps: MenubarSetupDeps): Menubar {
  const bar = deps.createMenubar({
    index: deps.trayIndexUrl,
    icon: deps.defaultIcon(),
    tooltip: 'DevBar',
    preloadWindow: true,
    browserWindow: {
      width: TRAY_POPOVER_WIDTH,
      height: 500,
      transparent: false,
      // The user may resize the popover by its edges (and drag it by its
      // header): the first time they do, it is pinned there.
      resizable: true,
      minWidth: TRAY_POPOVER_MIN_WIDTH,
      minHeight: TRAY_POPOVER_MIN_HEIGHT,
      // A double click on the header's drag region would otherwise zoom
      // (macOS) or maximize (Windows) the popover.
      maximizable: false,
      fullscreenable: false,
      // The tray popover is a utility surface, not a window: it must not claim
      // a taskbar entry on win/linux. Real windows keep their entries.
      skipTaskbar: true,
      icon: deps.windowIcon(),
      backgroundColor: deps.background(),
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });
  deps.attachTray(bar);

  bar.on('ready', () => {
    bar.tray.setImage(deps.defaultIcon());
    if (deps.isMac) bar.tray.setTitle('');
    // Once per run, so bug reports carry the backend the popover runs on.
    const displayLine = deps.displayLine();
    if (displayLine) console.log(`[display] linux backend: ${displayLine}`);
    if (deps.isLinux)
      patchLinuxTrayPositioning({
        positioner: bar.positioner as unknown as {
          calculate: (
            position: string,
            trayBounds?: Rectangle,
          ) => { x: number; y: number };
        },
        windowWidth: () => bar.window?.getSize()[0] ?? null,
        displayMatching: deps.displayMatching,
        sessionType: deps.sessionType,
      });
    // After the Linux patch, so a pinned spot is never re-clamped to the
    // display the tray icon is on.
    patchPinnedPositioning(
      bar.positioner as unknown as Parameters<typeof patchPinnedPositioning>[0],
      deps.pinnedPopover.position,
    );
    bar.tray.on('right-click', () =>
      bar.tray.popUpContextMenu(deps.buildContextMenu()),
    );
    deps.broadcast();
    deps.scheduleBootWork();
    // Light/dark appearance flip → rebuild the tray dot with a contrasting ring
    // so it stays visible on the new menubar background. In `auto` the native
    // window background resolves through the OS too — without the repaint, a
    // flip repaints the CSS but leaves the frame the old colour.
    deps.onThemeUpdated(() => {
      deps.invalidateTrayIconCache();
      deps.refreshTrayIcon();
      deps.repaintWindows();
    });
  });

  bar.on('after-create-window', () => {
    if (bar.window) {
      deps.attachConsole(bar.window, 'tray');
      deps.pinnedPopover.attach(bar.window);
    }
    deps.broadcast();
  });
  // menubar positions the popover between these two, synchronously.
  bar.on('show', () => deps.pinnedPopover.beforeShow());
  bar.on('after-show', () => deps.pinnedPopover.afterShow());
  return bar;
}
