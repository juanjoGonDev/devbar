import type { GlobalSettings, LogEntry } from '../../domain-types.js';
import type { GroupState, PipelineState } from '../../ipc-contract.js';
import type { ConfirmQueue } from '../confirm-queue.js';
import type { WindowRegistry } from '../renderer-bus.js';
import {
  createRuntimeActions,
  type RuntimeActionsDeps,
} from '../runtime-actions.js';
import { saveSettings, type SettingsSaveDeps } from '../settings-save.js';
import type { Updater } from '../updater.js';
import type { ControlApiDeps } from './control-api.js';
import type { RemoteRuntime } from './live.js';

/**
 * Everything «Control remoto» drives, assembled from collaborators main.ts
 * already has — the same process manager, confirmation queue, settings save
 * path and updater the windows use, never copies of their logic.
 */

/** What the live layer and the control API need from the app. */
export interface RemoteControlRuntime extends RemoteRuntime {
  actions: ControlApiDeps['runtime'];
  configStore: ControlApiDeps['configStore'];
  logs: ControlApiDeps['logs'];
  logSeq: ControlApiDeps['logSeq'];
  confirms: RemoteRuntime['confirms'] & ControlApiDeps['confirms'];
  settings: ControlApiDeps['settings'];
  updater: RemoteRuntime['updater'] & ControlApiDeps['updater'];
}

/** The slice of main.ts's collaborators this is built from. */
export interface RemoteAppWiring extends Omit<
  RuntimeActionsDeps,
  'configStore' | 'processManager'
> {
  host: { applyAutostart(enabled: boolean): void };
  configStore: RuntimeActionsDeps['configStore'] &
    SettingsSaveDeps['configStore'] & {
      getGlobalSettings(): GlobalSettings;
    };
  processManager: RuntimeActionsDeps['processManager'] & {
    getLogs(id: string): LogEntry[];
    getLogSeq(id: string): number;
    on(
      event: 'log',
      listener: (payload: { id: string; entry: LogEntry }) => void,
    ): unknown;
  };
  confirms: RuntimeActionsDeps['confirms'] &
    Pick<
      ConfirmQueue,
      'pending' | 'onChange' | 'hasPending' | 'resolveConfirm'
    >;
  snapshots: {
    snapshotGroupStates(): GroupState[];
    snapshotPipelineState(): PipelineState;
  };
  updater: Pick<
    Updater,
    'status' | 'canInstallStaged' | 'installStagedHeadless'
  >;
  repaintWindows(): void;
  sendTheme: SettingsSaveDeps['sendTheme'];
  registry: WindowRegistry;
}

export function remoteRuntime(app: RemoteAppWiring): RemoteControlRuntime {
  const actions = createRuntimeActions(app);
  const settingsDeps: SettingsSaveDeps = {
    configStore: app.configStore,
    applyAutostart: (enabled) => app.host.applyAutostart(enabled),
    refreshWindowBackgrounds: () => app.repaintWindows(),
    sendTheme: (theme) => app.sendTheme(theme),
    broadcast: () => app.broadcast(),
  };
  return {
    actions,
    configStore: app.configStore,
    groupStates: () => app.snapshots.snapshotGroupStates(),
    pipelineState: () => app.snapshots.snapshotPipelineState(),
    currentBranch: (groupId) => actions.currentBranch(groupId),
    logs: (id) => app.processManager.getLogs(id),
    logSeq: (id) => app.processManager.getLogSeq(id),
    onLog: (listener) => {
      app.processManager.on('log', listener);
    },
    confirms: app.confirms,
    settings: {
      get: () => app.configStore.getGlobalSettings(),
      save: (patch) => saveSettings(settingsDeps, patch),
    },
    updater: app.updater,
    // The phones hear the renderer stream as one more listener on the bus.
    onBus: (listener) => {
      app.registry.listeners.add({
        send: (channel, payload) => listener(channel, payload),
      });
    },
  };
}
