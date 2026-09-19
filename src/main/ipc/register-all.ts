import { openNotificationSettings } from '../notification-settings.js';
import type { IpcRegistrar } from '../ipc-validators.js';
import { registerAppIpc, type AppIpcDeps } from './app-ipc.js';
import { registerConfigIpc, type ConfigIpcDeps } from './config-ipc.js';
import { registerLogsIpc, type LogsIpcDeps } from './logs-ipc.js';
import { registerRuntimeIpc, type RuntimeIpcDeps } from './runtime-ipc.js';
import { registerWindowIpc, type WindowIpcDeps } from './window-ipc.js';

/**
 * One call that stands the whole IPC surface up. The five handler modules each
 * declare the narrow slice they need; this is where the app's collaborators and
 * its Electron host are matched to those slices, so `main.ts` hands over one
 * object and nothing has to repeat the adapter plumbing five times.
 */

interface IpcHost {
  messageBox: AppIpcDeps['dialogs']['message'];
  messageBoxForSender: WindowIpcDeps['showMessageBoxForSender'];
  openDialog: AppIpcDeps['dialogs']['open'];
  saveDialog: AppIpcDeps['dialogs']['save'];
  folderDialog: AppIpcDeps['dialogs']['folder'];
  files: AppIpcDeps['files'];
  applyAutostart: (enabled: boolean) => void;
  spawnDetached: Parameters<
    typeof openNotificationSettings
  >[0]['spawnDetached'];
  openExternal: (url: string) => void;
  openExternalAsync: (url: string) => Promise<unknown>;
  appVersion: () => string;
  appQuit: () => void;
  reportIssue: AppIpcDeps['reportIssue'];
  platform: NodeJS.Platform;
  /** XDG_CURRENT_DESKTOP, which names the Linux settings tool to launch. */
  desktop: string;
  devPanelAvailable: boolean;
}

export interface RegisterAllDeps {
  host: IpcHost;
  configStore: ConfigIpcDeps['configStore'] &
    RuntimeIpcDeps['configStore'] &
    LogsIpcDeps['configStore'] &
    AppIpcDeps['configStore'];
  processManager: ConfigIpcDeps['processManager'] &
    RuntimeIpcDeps['processManager'] &
    LogsIpcDeps['processManager'] &
    AppIpcDeps['processManager'];
  configIo: AppIpcDeps['configIo'];
  gitManager: RuntimeIpcDeps['gitManager'];
  preScriptRunner: RuntimeIpcDeps['preScriptRunner'];
  snapshots: ConfigIpcDeps['snapshots'] &
    RuntimeIpcDeps['snapshots'] &
    AppIpcDeps['snapshots'];
  confirms: RuntimeIpcDeps['confirms'];
  logWindows: LogsIpcDeps['logWindows'] & WindowIpcDeps['logWindows'];
  appWindows: WindowIpcDeps['appWindows'];
  notifications: WindowIpcDeps['notifications'];
  trayHost: WindowIpcDeps['trayHost'];
  updater: AppIpcDeps['updater'] & { installedBundleId: () => string | null };
  groupErrors: Map<string, string | null>;
  broadcast: () => void;
  syncRepoWatchers: () => void;
  expandTilde: (value: string) => string;
  repaintWindows: () => void;
  sendTheme: ConfigIpcDeps['sendTheme'];
  fetchReleases: AppIpcDeps['fetchReleases'];
  releasesUrl: string;
  iconBattery: unknown;
}

export function registerAllIpc(ipc: IpcRegistrar, deps: RegisterAllDeps): void {
  const { host } = deps;
  registerConfigIpc(ipc, {
    ...deps,
    applyAutostart: host.applyAutostart,
    refreshWindowBackgrounds: deps.repaintWindows,
  });
  registerRuntimeIpc(ipc, deps);
  registerLogsIpc(ipc, deps);
  registerWindowIpc(ipc, {
    ...deps,
    showMessageBoxForSender: host.messageBoxForSender,
  });
  registerAppIpc(ipc, {
    ...deps,
    files: host.files,
    dialogs: {
      save: host.saveDialog,
      open: host.openDialog,
      folder: host.folderDialog,
      message: host.messageBox,
    },
    applyAutostart: host.applyAutostart,
    devPanelAvailable: host.devPanelAvailable,
    appVersion: host.appVersion,
    appQuit: host.appQuit,
    reportIssue: host.reportIssue,
    openExternal: host.openExternal,
    openNotificationSettings: () =>
      openNotificationSettings({
        platform: host.platform,
        desktop: host.desktop,
        bundleId: deps.updater.installedBundleId,
        openExternal: host.openExternalAsync,
        spawnDetached: host.spawnDetached,
      }),
  });
}
