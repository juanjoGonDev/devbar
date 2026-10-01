import os from 'node:os';
import path from 'node:path';
import type { DevHooks } from '../dev/dev-ipc.js';
import type { FixtureEnvironment } from '../dev/fixture-groups.js';
import type { AvailableUpdate } from '../domain-types.js';
import type { ConfirmQueue } from './confirm-queue.js';
import type { TrayColor } from '../ipc-contract.js';

/**
 * The bridge the development-only simulation panel reaches the running app
 * through. Presence of `src/dev` IS the switch: a normal build strips it, and
 * a build made with DEVBAR_DEV_PANEL=1 keeps it — which is how the panel can be
 * exercised inside a REAL installed bundle, the only place notifications and
 * the updater behave for real.
 */

export interface DevPanelDeps {
  currentVersion: () => string;
  setSimulatedUpdate: (update: AvailableUpdate | null) => void;
  setSimulatedTrayColor: (color: TrayColor | null) => void;
  setSimulatedTrayCount: (count: number | null) => void;
  /** macOS renders the count as title text; applied before the next tick. */
  applyTrayTitleCount: (count: number | null) => void;
  refreshTrayIcon: () => void;
  broadcastUpdateStatus: () => void;
  showBanner: (
    title: string,
    body: string,
    options?: { cta?: { label: string; action: string } },
  ) => void;
  showFallbackBanner: (
    title: string,
    body: string,
    options?: { cta?: { label: string; action: string } },
  ) => void;
  showCompletionNotification: (title: string, body: string) => void;
  showConfirmModal: ConfirmQueue['showConfirmModal'];
  toast: (kind: string, message: string) => void;
  installedBundle: () => string | null;
  updatesDir: () => string;
  stageFromZip: (zipPath: string, version: string) => Promise<void>;
  removeFile: (target: string) => void;
  stagedVersion: () => string | null;
  pruneStagedUpdates: (keep: string) => void;
  fixtures: DevHooks['fixtures'];
}

/**
 * Where the dev panel's test groups run. In a dev run the app path is the
 * checkout itself, which gives one fixture a real branch selector; an
 * installed app has no repository to offer, so everything uses the temp dir.
 */
export function fixtureEnvironment(input: {
  platform: NodeJS.Platform;
  execPath: string;
  tmpDir: string;
  appPath: string;
  isPackaged: boolean;
  exists: (target: string) => boolean;
}): FixtureEnvironment {
  const isCheckout =
    !input.isPackaged && input.exists(path.join(input.appPath, '.git'));
  return {
    platform: input.platform,
    execPath: input.execPath,
    tmpDir: input.tmpDir,
    repoPath: isCheckout ? input.appPath : null,
  };
}

/**
 * The running app's side of the "Grupos de prueba" overlay: the groups
 * overlay in the store, the process manager the fixture processes run in, and
 * the repaint that shows the swap in every window.
 */
export function createFixtureHost(deps: {
  app: { isPackaged: boolean; getAppPath: () => string };
  pathExists: (target: string) => boolean;
  setOverlay: DevHooks['fixtures']['setOverlay'];
  processManager: {
    allStates: () => readonly { id: string }[];
    stop: DevHooks['fixtures']['stop'];
    removeState: (id: string) => void;
  };
  refresh: () => void;
}): DevHooks['fixtures'] {
  return {
    environment: () =>
      fixtureEnvironment({
        platform: process.platform,
        execPath: process.execPath,
        tmpDir: os.tmpdir(),
        appPath: deps.app.getAppPath(),
        isPackaged: deps.app.isPackaged,
        exists: deps.pathExists,
      }),
    setOverlay: deps.setOverlay,
    processIds: () => deps.processManager.allStates().map((entry) => entry.id),
    stop: (id) => deps.processManager.stop(id),
    removeState: (id) => deps.processManager.removeState(id),
    refresh: deps.refresh,
  };
}

export function createDevHooks(deps: DevPanelDeps): DevHooks {
  return {
    currentVersion: () => deps.currentVersion(),
    setSimulatedUpdate: (update) => {
      deps.setSimulatedUpdate(update);
      deps.refreshTrayIcon();
      deps.broadcastUpdateStatus();
    },
    setSimulatedTrayColor: (color) => deps.setSimulatedTrayColor(color),
    setSimulatedTrayCount: (count) => {
      deps.setSimulatedTrayCount(count);
      deps.applyTrayTitleCount(count);
      deps.refreshTrayIcon();
    },
    showBanner: (title, body, options) => deps.showBanner(title, body, options),
    showFallbackBanner: (title, body, options) =>
      deps.showFallbackBanner(title, body, options),
    showCompletionNotification: (title, body) =>
      deps.showCompletionNotification(title, body),
    // Dev-only manual trigger, unrelated to the real pipeline: a pipeline
    // cancel must never close this simulated dialog, and no real group backs
    // it.
    openPrescriptConfirm: (name, command) =>
      void deps.showConfirmModal(
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
    toast: (kind, message) => deps.toast(kind, message),
    fixtures: deps.fixtures,
    // Not process.execPath: unpackaged that resolves to Electron's own bundle,
    // which passes the guard and then fails deep inside the copy.
    installedBundle: () => deps.installedBundle(),
    updatesDir: () => deps.updatesDir(),
    stageLocalUpdate: async (zipPath, version) => {
      try {
        await deps.stageFromZip(zipPath, version);
      } finally {
        deps.removeFile(zipPath);
        // Prune by what IS staged, not by what we wanted to stage: on a failure
        // the latter deletes the update already waiting, and the staged pointer
        // would still point into that directory.
        const staged = deps.stagedVersion();
        if (staged !== null) deps.pruneStagedUpdates(staged);
      }
    },
  };
}

/**
 * Load the panel's IPC surface, if this build carries it. The dynamic import
 * is what lets a packaged build drop `src/dev` entirely: the module simply is
 * not there, and the rejection is the expected outcome rather than an error.
 */
export function registerDevPanel(
  available: boolean,
  deps: DevPanelDeps,
  load: () => Promise<{ registerDevIpc: (hooks: DevHooks) => void }>,
): void {
  if (!available) return;
  void load()
    .then(({ registerDevIpc }) => registerDevIpc(createDevHooks(deps)))
    .catch(() => {
      /* dev panel absent (packaged build) — nothing to register */
    });
}
