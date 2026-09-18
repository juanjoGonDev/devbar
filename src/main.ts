import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  Tray,
} from 'electron';
import { menubar, type Menubar } from 'menubar';
import { appHome } from './app-paths.js';
import * as configStore from './config-store.js';
import * as configIo from './config-io.js';
import * as gitManager from './git-manager.js';
import * as logger from './logger.js';
import * as selfUpdate from './self-update.js';
import * as trayIcon from './tray-icon.js';
import * as updateCheck from './update-check.js';
import { ProcessManager } from './process-manager.js';
import { SessionResumeTracker, consumeSnapshot } from './session-resume.js';
import { isMac, platformLabel } from './platform.js';
import { loadShellPath, expandTilde } from './path-helper.js';
import { RepoWatcher } from './repo-watcher.js';
import { createPreScriptRunner } from './pre-script-runner.js';
import { ICON_BATTERY } from './icon-battery.js';
import { createAppWindows } from './main/app-windows.js';
import { createConfirmQueue } from './main/confirm-queue.js';
import { registerDevPanel } from './main/dev-panel.js';
import { downloadFile } from './main/download-file.js';
import { createElectronHost } from './main/electron-host.js';
import { setupMenubar, wireProcessEvents } from './main/lifecycle.js';
import { createLogWindows } from './main/log-windows.js';
import { createNotifications } from './main/notification-banner.js';
import {
  anyAppWindowOpen,
  applyDockVisibility,
  createWindowRegistry,
  refreshWindowBackgrounds,
  sendToRenderers,
  themeTargets,
} from './main/renderer-bus.js';
import { createScheduleRunner } from './main/schedule-runner.js';
import { createShutdownController } from './main/shutdown.js';
import { isSmokeMode, runSmokeMode } from './main/smoke-mode.js';
import { createStartup } from './main/startup.js';
import { createStateSnapshots } from './main/state-snapshot.js';
import { createTrayController } from './main/tray.js';
import { buildTrayMenuTemplate } from './main/tray-view.js';
import { createUpdater } from './main/updater.js';
import { registerAllIpc } from './main/ipc/register-all.js';
import type { Group } from './domain-types.js';

/**
 * Wiring only. Every decision this process makes lives under `src/main/`; what
 * is left here is the composition root that connects those modules to the
 * Electron host, plus the app lifecycle that starts them.
 */
const UPDATE_REPO = { owner: 'juanjoGonDev', repo: 'devbar' };
const SMOKE_MODE = isSmokeMode(process.argv, process.env);
const SMOKE_MARKER_PATH = path.join(os.tmpdir(), 'devbar-smoke-ok');

// Keep the app identity consistent across platforms. macOS already gets
// "DevBar" from the bundle (CFBundleName); Windows and Linux would fall back to
// the package.json `name` ("devbar"). The pin moves the name (and, on Windows,
// the default paths); on Linux the XDG directory is resolved at process start,
// so the data locations are pinned explicitly in app-paths.ts instead.
if (app.isPackaged) app.name = 'DevBar';

loadShellPath();

const isPrimary = app.requestSingleInstanceLock();
const processManager = new ProcessManager(configStore);
const repoWatcher = new RepoWatcher();
/** Group-level transient errors (not persisted). */
const groupErrors = new Map<string, string | null>();
// Created in whenReady (it needs the app-data dir); null until then.
let sessionResume: SessionResumeTracker | null = null;
let menuBar: Menubar | null = null;

const registry = createWindowRegistry(() => menuBar?.window ?? null);
const host = createElectronHost({
  dirname: path.dirname(fileURLToPath(import.meta.url)),
  themePreference: () => configStore.getGlobalSettings().theme,
  dialogOwner: () =>
    (registry.config as BrowserWindow | null) ??
    menuBar?.window ??
    BrowserWindow.getFocusedWindow(),
});

// File logger, initialised before anything noisy so we capture early
// `console.*` from the main process. The renderer side is hooked later, when
// each BrowserWindow is created (we need its `webContents` to subscribe).
try {
  logger.init({ filePath: host.logFilePath() });
  logger.attachMainConsole();
} catch (e) {
  console.error('logger init failed:', e); // never block startup
}

// ─────────────────────── Composition root ────────────────────────────

const preScriptRunner = createPreScriptRunner({
  processManager,
  configStore,
  broadcastUpdate: () => broadcast(),
  onStepComplete: ({ stepIndex }) => startup.onPipelineStepComplete(stepIndex),
  onError: (err: string) => {
    if (startup.shouldShowGenericFailureToast())
      toast('error', `Pre-scripts: ${err}`);
  },
  onSuccess: ({ stepCount }: { runId: number; stepCount: number }) =>
    notifications.showCompletionNotification(
      'DevBar — pre-scripts',
      `Pipeline completado (${stepCount} paso${stepCount === 1 ? '' : 's'})`,
    ),
  confirmScript: (script, group) => confirms.confirmScript(script, group),
  cancelConfirm: () => confirms.cancelConfirm(),
});

const snapshots = createStateSnapshots({
  configStore,
  processManager,
  preScriptRunner,
  groupErrors,
});

function broadcast(): void {
  const payload = snapshots.snapshotGroupStates();
  sendToRenderers(registry, 'groups:update', payload);
  sendToRenderers(
    registry,
    'pipeline:update',
    snapshots.snapshotPipelineState(),
  );
  tray.updateTitle(payload);
}
const toast = (kind: string, message: string): void =>
  sendToRenderers(registry, 'groups:toast', { kind, message });
const repaintWindows = (): void =>
  refreshWindowBackgrounds(registry, host.background());

const tray = createTrayController({
  loadIcon: trayIcon.loadIcon,
  isMac,
  hasUpdate: () => updater.available() !== null,
});

const confirms = createConfirmQueue({
  openWindow: (token) => appWindows.ensurePrescriptConfirmWindow(token),
  logo: host.confirmLogo,
});

const chrome = {
  registry,
  createWindow: host.createWindow,
  rendererFile: host.rendererFile,
  preloadPath: host.preloadPath,
  windowIcon: host.windowIcon,
  background: host.background,
  workArea: host.workArea,
  attachConsole: logger.attachWindowConsole,
  onWindowsChanged: () =>
    applyDockVisibility(isMac ? app.dock : null, anyAppWindowOpen(registry)),
  isMac,
};

const logWindows = createLogWindows({
  ...chrome,
  resolveTargetName: (processId) =>
    processManager.resolveTarget(processId)?.target.name ?? processId,
});

const appWindows = createAppWindows({
  ...chrome,
  platformLabel,
  commandName: (groupId, commandId) =>
    configStore.getGroup(groupId)?.commands?.find((c) => c.id === commandId)
      ?.name ?? null,
  onConfirmWindowClosed: (token) => {
    if (confirms.hasPending(token)) confirms.resolveConfirm(token, 'cancel');
  },
});

const notifications = createNotifications({
  createWindow: host.createWindow,
  createNotification: (options) => new Notification(options),
  notificationsSupported: () => Notification.isSupported(),
  rendererFile: host.rendererFile,
  preloadPath: host.preloadPath,
  workArea: host.workArea,
  notifySuccessEnabled: () => configStore.getGlobalSettings().notifySuccess,
  openConfig: (goto) => appWindows.ensureConfigWindow({ goto }),
  applyUpdate: () => void updater.applyUpdate(),
});

const updater = createUpdater({
  ...selfUpdate,
  ...updateCheck,
  ...host,
  downloadFile,
  repo: UPDATE_REPO,
  sendUpdateStatus: (payload) =>
    sendToRenderers(registry, 'updates:status', payload),
  refreshTrayIcon: tray.refreshIcon,
  showBannerNotification: notifications.showBannerNotification,
  toast,
  markUpdateExit: () => shutdown.markUpdateExit(),
  quitAfter: (ms) => setTimeout(() => app.quit(), ms),
  configFocused: () =>
    Boolean(registry.config && (registry.config as BrowserWindow).isFocused()),
});

const startup = createStartup({
  processManager,
  configStore,
  preScriptRunner,
  consumeSnapshot: (canResume) => consumeSnapshot(appHome(), canResume),
  broadcastToast: toast,
  showCompletionNotification: notifications.showCompletionNotification,
  wasOpenedAtLogin: host.wasOpenedAtLogin,
  // DEVBAR_FORCE_LOGIN=1 forces the "opened at login" path — for testing the
  // boot auto-run flow without rebooting.
  forceLogin: process.env.DEVBAR_FORCE_LOGIN === '1',
});

const schedules = createScheduleRunner({
  configStore,
  processManager,
  confirmIfNeeded: (target, group) => confirms.confirmIfNeeded(target, group),
  broadcast,
});

/** The command services currently running (actions/pre-scripts are one-shots). */
function runningCommandIds(): string[] {
  return processManager
    .allStates()
    .filter((entry) => entry.kind === 'command' && entry.status === 'running')
    .map((entry) => entry.id);
}

const shutdown = createShutdownController({
  isPrimary,
  smokeMode: SMOKE_MODE,
  repoWatcher,
  preScriptRunner,
  processManager,
  sessionResume: () => sessionResume,
  runningCommandIds,
  releaseConfigCloseGuard: appWindows.releaseConfigCloseGuard,
  appQuit: () => app.quit(),
  processExit: (code) => process.exit(code),
});

function syncRepoWatchers(): void {
  const groups: Group[] = configStore.listGroups();
  repoWatcher.sync([
    ...new Set(groups.map((g) => expandTilde(g.path)).filter(Boolean)),
  ]);
}

const trayHost = {
  hideIfVisible: () => {
    if (menuBar?.window?.isVisible()) menuBar.hideWindow();
  },
  hide: () => menuBar?.hideWindow(),
  popover: () => menuBar?.window ?? null,
  workAreaHeight: host.workAreaHeight,
};

// Presence of the files IS the switch, rather than `!app.isPackaged`. A normal
// build strips src/dev and renderer/dev, so this is off; a build made with
// DEVBAR_DEV_PANEL=1 keeps them, which is how the panel can be exercised inside
// a REAL installed bundle — the only place notifications and the updater behave
// for real.
const devHooks = {
  currentVersion: host.appVersion,
  setSimulatedUpdate: updater.setSimulatedUpdate,
  setSimulatedTrayColor: tray.setSimulatedColor,
  setSimulatedTrayCount: tray.setSimulatedCount,
  applyTrayTitleCount: (count: number | null) => {
    if (isMac && menuBar?.tray) menuBar.tray.setTitle(count ? ` ${count}` : '');
  },
  refreshTrayIcon: tray.refreshIcon,
  broadcastUpdateStatus: updater.broadcastStatus,
  showBanner: notifications.showBannerNotification,
  showFallbackBanner: notifications.showCustomBanner,
  showCompletionNotification: notifications.showCompletionNotification,
  // Dev-only manual trigger, unrelated to the real pipeline: a pipeline cancel
  // must never close this simulated dialog, and no real group backs it.
  openPrescriptConfirm: (name: string, command: string) =>
    void confirms.showConfirmModal(
      {
        name,
        command,
        args: [],
        confirmSecs: null,
        confirmOnTimeout: 'cancel',
      },
      'interactive',
      null,
    ),
  toast,
  installedBundle: selfUpdate.installedAppPath,
  updatesDir: host.updatesDir,
  stageFromZip: updater.stageFromZip,
  removeFile: host.removeFile,
  stagedVersion: () => updater.staged()?.version ?? null,
  pruneStagedUpdates: updater.pruneStagedUpdates,
};

function registerIpc(): void {
  registerAllIpc(ipcMain, {
    ...host,
    host,
    configStore,
    processManager,
    configIo,
    gitManager,
    preScriptRunner,
    snapshots,
    confirms,
    logWindows,
    appWindows,
    notifications,
    trayHost,
    updater,
    groupErrors,
    broadcast,
    syncRepoWatchers,
    expandTilde,
    repaintWindows,
    sendTheme: (theme) => {
      for (const wc of themeTargets(registry)) wc.send('settings:theme', theme);
    },
    fetchReleases: (limit) =>
      updateCheck.fetchReleases({ ...UPDATE_REPO, limit }),
    releasesUrl: `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`,
    iconBattery: ICON_BATTERY,
  });
  registerDevPanel(
    host.devPanelAvailable,
    devHooks,
    () => import('./dev/dev-ipc.js'),
  );
}

/**
 * Work that only makes sense once the tray exists: the 300 ms delay lets the
 * renderer paint its initial empty state before boot auto-start floods it, and
 * the schedule loop is aligned to the wall-clock minute so a 13:02 schedule
 * fires at ~13:02:00 rather than up to 59 s late.
 */
function scheduleBootWork(): void {
  setTimeout(() => void startup.autoStartAllMarkedCommands(), 300);
  setTimeout(() => void schedules.checkSchedules(new Date()), 1000);
  schedules.startScheduleLoop();
  powerMonitor.on('resume', () => void schedules.checkSchedules(new Date()));
  void updater.runUpdateCheck();
  setInterval(() => void updater.runUpdateCheck(), 5 * 60 * 1000);
}

// ─────────────────────── App lifecycle ───────────────────────────────

// Single-instance lock. DevBar is a menubar app backed by one electron-store
// file; a second launch (e.g. login item + manual open) would spawn a duelling
// tray icon writing the same store. The second instance focuses config on the
// primary and exits. `isPrimary` also guards the ready handlers, since a second
// instance may still emit 'ready' before app.quit() takes effect.
if (!isPrimary) {
  app.quit();
} else {
  app.on('second-instance', () => appWindows.ensureConfigWindow());
}

app.on('ready', () => {
  if (!isPrimary) return;
  if (isMac && app.dock) {
    app.dock.hide();
    chrome.onWindowsChanged();
  }
});

app.whenReady().then(() => {
  if (!isPrimary) return;
  registerIpc();
  // Smoke mode must not touch the user's auto-start registration on a CI host.
  if (!SMOKE_MODE)
    host.applyAutostart(configStore.getGlobalSettings().autostart);
  wireProcessEvents({
    processManager,
    repoWatcher,
    broadcast,
    toast,
    broadcastLog: logWindows.broadcastLog,
    branchesChanged: (repoPath) =>
      sendToRenderers(registry, 'branches:changed', { path: repoPath }),
    claimScheduledAction: schedules.claimScheduledAction,
    showCompletionNotification: notifications.showCompletionNotification,
    // Keep the snapshot's running set current (debounced, and a no-op when the
    // set is unchanged). Never track DURING shutdown: stopAll() emits 'change'
    // for each service as it stops, and a re-armed 'live' write after flush()
    // would overwrite the authoritative kill/update snapshot.
    trackResume: () => {
      if (!SMOKE_MODE && sessionResume && shutdown.phase() === 'idle')
        sessionResume.track(runningCommandIds());
    },
  });
  syncRepoWatchers();

  if (!SMOKE_MODE) {
    sessionResume = new SessionResumeTracker(appHome());
    startup.resumeSavedServices();
  }

  trayIcon.preload();

  if (SMOKE_MODE) {
    runSmokeMode({
      ...selfUpdate,
      ...host,
      argv: process.argv,
      env: process.env,
      platform: process.platform,
      pid: process.pid,
      version: host.appVersion,
      removeMarker: () => host.removeFile(SMOKE_MARKER_PATH),
      writeMarker: (contents) => host.writeFile(SMOKE_MARKER_PATH, contents),
      createTray: () => new Tray(trayIcon.defaultIcon()),
      exit: (code) => app.exit(code),
      setTimer: (fn, ms) => setTimeout(fn, ms),
    });
    return;
  }

  menuBar = setupMenubar({
    ...host,
    createMenubar: menubar,
    trayIndexUrl: `file://${host.rendererFile('tray.html')}`,
    defaultIcon: trayIcon.defaultIcon,
    attachTray: tray.attach,
    attachConsole: logger.attachWindowConsole,
    buildContextMenu: () =>
      Menu.buildFromTemplate(
        buildTrayMenuTemplate({
          availableUpdate: updater.available(),
          stagedUpdate: updater.staged(),
          logWindows: [...registry.logs.entries()],
          onApplyUpdate: () => void updater.applyUpdate(),
          onOpenConfig: () => appWindows.ensureConfigWindow(),
        }),
      ),
    broadcast,
    refreshTrayIcon: tray.refreshIcon,
    invalidateTrayIconCache: trayIcon.invalidateCache,
    repaintWindows,
    scheduleBootWork,
  });
});

app.on('window-all-closed', () => {
  // Keep the menubar app alive; Electron only quits automatically when no
  // listener is registered for this event.
});

app.on('before-quit', (event) => shutdown.onBeforeQuit(event));
process.on('SIGINT', () => shutdown.onTerminalSignal());
process.on('SIGTERM', () => shutdown.onTerminalSignal());
