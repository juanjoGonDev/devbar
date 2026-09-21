import { describe, expect, it } from 'vitest';
import {
  registerAllIpc,
  type RegisterAllDeps,
} from '../src/main/ipc/register-all.js';
import { makeSettings, recordingIpc } from './helpers/main-fakes.js';

function harness(overrides: Partial<RegisterAllDeps> = {}) {
  const calls: string[] = [];
  const host: RegisterAllDeps['host'] = {
    messageBox: () => Promise.resolve({ response: 0 }),
    messageBoxForSender: () => Promise.resolve({ response: 0 }),
    openDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    saveDialog: () => Promise.resolve({ canceled: true }),
    folderDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    files: { readText: () => '', writeText: () => undefined },
    applyAutostart: (enabled) => calls.push(`autostart:${enabled}`),
    spawnDetached: () => {
      calls.push('spawn');
      return { once: () => undefined, unref: () => undefined };
    },
    openExternal: (url) => calls.push(`external:${url}`),
    openExternalAsync: (url) => {
      calls.push(`externalAsync:${url}`);
      return Promise.resolve();
    },
    appVersion: () => '1.2.0',
    appQuit: () => calls.push('quit'),
    copyReport: () => ({ ok: true }),
    reportIssue: () => ({
      url: 'https://github.test/issues/new',
      bodyIncluded: true,
    }),
    platform: 'darwin',
    desktop: '',
    devPanelAvailable: false,
  };
  const noop = () => undefined;
  const deps = {
    host,
    configStore: {
      listGroups: () => [],
      getGroup: () => null,
      getGlobalSettings: () => makeSettings(),
      getPreSteps: () => [],
      exportConfig: () => ({}),
      replaceConfig: noop,
      writeImportBackup: () => '/backup.json',
      saveGroup: () => ({}),
      deleteGroup: noop,
      reorderGroups: () => [],
      saveCommand: () => null,
      deleteCommand: noop,
      reorderCommands: () => [],
      saveAction: () => null,
      deleteAction: noop,
      reorderActions: () => [],
      savePreStep: () => ({}),
      deletePreStep: noop,
      reorderPreSteps: () => [],
      assignScriptToStep: () => ({}),
      unassignScriptFromStep: () => ({}),
      savePreScript: () => null,
      deletePreScript: noop,
      reorderPreScripts: () => [],
      addSilencedPattern: () => null,
      removeSilencedPattern: () => null,
      setCommandSilence: () => null,
      setGroupSilence: () => null,
      saveGlobalSettings: () => makeSettings(),
    },
    processManager: {
      stop: () => Promise.resolve({ ok: true }),
      stopAll: () => Promise.resolve({ ok: true, failed: [] }),
      removeState: noop,
      recount: noop,
      start: () => ({ ok: true }),
      getState: () => ({}),
      resolveTarget: () => null,
      getLogs: () => [],
      getLogLimit: () => 0,
      getLogSeq: () => 0,
      listLogBuffers: () => [],
      clearLogs: () => true,
    },
    configIo: {
      validateImportedConfig: () => ({ ok: false, error: 'x' }),
      summarizeImport: () => ({}),
    },
    gitManager: {
      listBranches: () => Promise.resolve({}),
      currentBranch: () => Promise.resolve({}),
      switchBranch: () => Promise.resolve({ ok: true }),
    },
    preScriptRunner: {
      run: () => Promise.resolve({}),
      cancel: () => ({ ok: true }),
    },
    snapshots: {
      snapshotGroupStates: () => [],
      snapshotPipelineState: () => ({}),
      forgetPipelineRunId: () => calls.push('forgetRunId'),
    },
    confirms: {
      confirmIfNeeded: () => Promise.resolve(true),
      getContext: () => null,
      resolveConfirm: noop,
    },
    logWindows: {
      isSharedWindowSender: () => false,
      watchSingle: noop,
      watchScope: noop,
      ensureLogsWindow: () => ({}),
      ensureLogsScopeWindow: () => ({}),
    },
    appWindows: {
      ensureConfigWindow: () => calls.push('config'),
      confirmCloseConfig: noop,
      ensureSilencedWindow: () => null,
    },
    notifications: {
      showBannerNotification: noop,
      closeNotificationWindow: noop,
      runNotificationAction: noop,
    },
    trayHost: {
      hideIfVisible: noop,
      hide: noop,
      popover: () => null,
      workAreaHeight: () => 900,
    },
    updater: {
      status: () => ({}),
      runUpdateCheck: () => Promise.resolve({}),
      applyUpdate: () => Promise.resolve({ ok: true }),
      installedBundleId: () => 'dev.devbar.app',
    },
    groupErrors: new Map<string, string | null>(),
    broadcast: () => calls.push('broadcast'),
    syncRepoWatchers: noop,
    expandTilde: (value: string) => value,
    repaintWindows: () => calls.push('repaint'),
    sendTheme: () => calls.push('theme'),
    fetchReleases: () => Promise.resolve([]),
    releasesUrl: 'https://github.test/releases',
    iconBattery: {},
    ...overrides,
  } as unknown as RegisterAllDeps;
  const ipc = recordingIpc();
  registerAllIpc(ipc, deps);
  return { ipc, calls };
}

describe('src/main/ipc/register-all.ts', () => {
  describe('registerAllIpc', () => {
    it('stands the whole surface up in one call', () => {
      const h = harness();
      // One representative channel from each handler module.
      expect(h.ipc.channels()).toEqual(
        expect.arrayContaining([
          'groups:list',
          'process:start',
          'logs:list',
          'window:openConfig',
          'updates:status',
        ]),
      );
      expect(h.ipc.channels().length).toBeGreaterThan(50);
    });

    it('registers no channel twice', () => {
      const channels = harness().ipc.channels();
      expect(new Set(channels).size).toBe(channels.length);
    });

    it('routes autostart through the host, not the app modules', () => {
      const h = harness();
      h.ipc.invoke('settings:save', { autostart: true });
      expect(h.calls).toContain('autostart:false');
    });

    it('wires the notification-settings flow to the host and the bundle id', async () => {
      const h = harness();
      await expect(
        h.ipc.invoke('app:openNotificationSettings'),
      ).resolves.toEqual({ ok: true });
      expect(h.calls.some((call) => call.startsWith('externalAsync:'))).toBe(
        true,
      );
    });

    it('passes the dev-panel flag from the host through', () => {
      const h = harness();
      expect(h.ipc.invoke('app:isDev')).toBe(false);
    });
  });
});
