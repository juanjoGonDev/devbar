import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  NativeImage,
} from 'electron';
import { belongsToMergedScope, parseProcessId } from '../compound-id.js';
import { adaptiveSize, type Rect } from './window-geometry.js';
import { MAIN_LOGS_KEY, type WindowRegistry } from './renderer-bus.js';
import type { LogEntry } from '../domain-types.js';

/**
 * The logs windows: the shared multi-log window (sidebar + one visible log or
 * a merged scope) and any number of detached single-log ones.
 *
 * The shared window only receives lines for what it is currently showing, so N
 * running services don't flood it with N streams — and the membership rule it
 * uses to decide that is the SAME `belongsToMergedScope` the snapshot uses, so
 * the view can never list a buffer the live stream then withholds.
 */

export interface LogWindowsDeps {
  registry: WindowRegistry;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  /** Absolute path of a file under `renderer/`. */
  rendererFile: (name: string) => string;
  preloadPath: string;
  windowIcon: () => NativeImage;
  background: () => string;
  /** Work area of the display the user is actually looking at. */
  workArea: () => Rect;
  attachConsole: (win: BrowserWindow, label: string) => void;
  /** Dock visibility follows the open-window count. */
  onWindowsChanged: () => void;
  isMac: boolean;
  /** Window-title name for a process id, falling back to the id itself. */
  resolveTargetName: (processId: string) => string;
}

export interface LogWindows {
  ensureLogsWindow: (
    processId: string,
    options?: {
      filter?: string | undefined;
      detached?: boolean | undefined;
      level?: 'warn' | 'error' | undefined;
    },
  ) => BrowserWindow;
  ensureLogsScopeWindow: (
    scope: 'all' | 'group',
    groupId: string | null,
    level: 'warn' | 'error' | null,
  ) => BrowserWindow;
  broadcastLog: (payload: { id: string; entry: LogEntry }) => void;
  /** True when `sender` is the shared window's webContents. */
  isSharedWindowSender: (sender: unknown) => boolean;
  /** The shared window switched to one service (leaving any merged view). */
  watchSingle: (processId: string) => void;
  /** The shared window switched to a merged scope; null groupId = every group. */
  watchScope: (groupId: string | null) => void;
}

export function createLogWindows(deps: LogWindowsDeps): LogWindows {
  const { registry } = deps;
  // Which log the shared window is currently showing.
  let mainLogsWatching: string | null = null;
  /*
   * The merged scope the shared window is showing, or null when it shows one
   * service. `{ groupId: null }` means every group.
   *
   * Gating by SCOPE rather than by a snapshot of ids is what lets a pre-script
   * whose first run starts after the view opened still stream into it — its id
   * cannot be in a set captured beforehand, but its group is known.
   */
  let mainLogsScope: { groupId: string | null } | null = null;

  /** The BrowserWindow itself, shared by the single-log and merged entry points. */
  function buildLogsWindow({
    title,
    detached,
    processId,
    query,
  }: {
    title: string;
    detached: boolean;
    processId: string;
    query: Record<string, string>;
  }): BrowserWindow {
    const size = adaptiveSize(deps.workArea(), detached ? 960 : 1180, 640);
    const win = deps.createWindow({
      width: size.width,
      height: size.height,
      x: size.x,
      y: size.y,
      minWidth: detached ? 480 : 720,
      minHeight: 320,
      title,
      icon: deps.windowIcon(),
      // hiddenInset + traffic lights are macOS chrome; elsewhere the native
      // titlebar is the least-surprising option.
      ...(deps.isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 12, y: 14 },
          }
        : {}),
      backgroundColor: deps.background(),
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--process-id=${processId}`],
      },
    });
    win.setMenuBarVisibility(false);
    // NOT visible-on-all-workspaces: on a secondary display that made macOS
    // minimize the other windows there (accessory-app + join-all-spaces quirk).
    void win.loadFile(deps.rendererFile('logs.html'), { query });
    return win;
  }

  /**
   * Open the shared logs window straight onto a merged scope. A live window is
   * told to switch; a cold one carries the scope in its query string so it
   * opens already showing it, with no single-service flash in between.
   */
  function ensureLogsScopeWindow(
    scope: 'all' | 'group',
    groupId: string | null,
    level: 'warn' | 'error' | null,
  ): BrowserWindow {
    const existing = registry.logs.get(MAIN_LOGS_KEY) as
      BrowserWindow | undefined;
    if (existing && !existing.isDestroyed()) {
      existing.webContents.send('logs:select', { scope, groupId, level });
      existing.show();
      existing.focus();
      return existing;
    }
    const query: Record<string, string> = { scope };
    if (groupId) query.groupId = groupId;
    if (level) query.level = level;
    const win = buildLogsWindow({
      title: scope === 'all' ? 'DevBar — Telemetría' : 'DevBar — Logs',
      detached: false,
      processId: '',
      query,
    });
    registry.logs.set(MAIN_LOGS_KEY, win);
    win.on('closed', () => {
      registry.logs.delete(MAIN_LOGS_KEY);
      mainLogsWatching = null;
      mainLogsScope = null;
      deps.onWindowsChanged();
    });
    deps.attachConsole(win, `logs:${scope}`);
    deps.onWindowsChanged();
    return win;
  }

  function ensureLogsWindow(
    processId: string,
    {
      filter,
      detached,
      level,
    }: {
      filter?: string | undefined;
      detached?: boolean | undefined;
      level?: 'warn' | 'error' | undefined;
    } = {},
  ): BrowserWindow {
    const key = detached ? processId : MAIN_LOGS_KEY;
    const existing = registry.logs.get(key) as BrowserWindow | undefined;
    if (existing && !existing.isDestroyed()) {
      // Re-selecting the log already on screen would clear and refetch it for
      // nothing; only tell the renderer when something actually changes.
      if (detached || processId !== mainLogsWatching || filter || level) {
        existing.webContents.send('logs:select', { processId, filter, level });
      }
      if (!detached) mainLogsWatching = processId;
      existing.show();
      existing.focus();
      return existing;
    }
    const query: Record<string, string> = { id: processId };
    if (filter) query.filter = filter;
    if (level) query.level = level;
    if (detached) query.detached = '1';
    else mainLogsWatching = processId;
    const win = buildLogsWindow({
      title: `Logs — ${deps.resolveTargetName(processId)}`,
      detached: Boolean(detached),
      processId,
      query,
    });
    win.on('closed', () => {
      registry.logs.delete(key);
      if (!detached) mainLogsWatching = null;
      deps.onWindowsChanged();
    });
    registry.logs.set(key, win);
    deps.attachConsole(win, `logs:${processId}`);
    deps.onWindowsChanged();
    return win;
  }

  function broadcastLog(payload: { id: string; entry: LogEntry }): void {
    const detached = registry.logs.get(payload.id);
    if (detached && !detached.isDestroyed()) {
      detached.webContents.send('logs:line', payload);
    }
    const main = registry.logs.get(MAIN_LOGS_KEY);
    const parsed = parseProcessId(payload.id);
    // Same membership rule the snapshot uses, so the view cannot list a buffer
    // it then never receives lines from.
    const inScope =
      mainLogsScope !== null &&
      belongsToMergedScope(parsed, mainLogsScope.groupId);
    if (
      main &&
      !main.isDestroyed() &&
      (mainLogsWatching === payload.id || inScope)
    ) {
      main.webContents.send('logs:line', payload);
    }
  }

  return {
    ensureLogsWindow,
    ensureLogsScopeWindow,
    broadcastLog,

    isSharedWindowSender(sender): boolean {
      const main = registry.logs.get(MAIN_LOGS_KEY);
      return Boolean(
        main && !main.isDestroyed() && (main.webContents as unknown) === sender,
      );
    },

    watchSingle(processId): void {
      mainLogsWatching = processId;
      mainLogsScope = null; // leaving the merged view
    },

    watchScope(groupId): void {
      mainLogsWatching = null;
      mainLogsScope = { groupId };
    },
  };
}
