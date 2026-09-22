import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/preload.ts` is the whole security boundary between every renderer and
 * main: the only thing a window can reach is what this file chooses to put on
 * `window.api`, and each method is a hand-written mapping onto one IPC
 * channel. A typo in a channel name or a reshaped payload is invisible to the
 * type checker (both sides are `invoke(channel, unknown)`) and shows up only
 * as a dead button at runtime — so the mapping itself is what is asserted
 * here, method by method.
 */

interface InvokeCall {
  channel: string;
  args: unknown[];
}
interface Subscription {
  channel: string;
  handler: (event: unknown, payload: unknown) => void;
}

const ipc = vi.hoisted(() => ({
  invokes: [] as InvokeCall[],
  on: [] as Subscription[],
  removed: [] as Subscription[],
  exposed: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      ipc.exposed.set(key, value);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      ipc.invokes.push({ channel, args });
      return Promise.resolve({ channel });
    },
    on: (
      channel: string,
      handler: (event: unknown, payload: unknown) => void,
    ) => {
      ipc.on.push({ channel, handler });
    },
    removeListener: (
      channel: string,
      handler: (event: unknown, payload: unknown) => void,
    ) => {
      ipc.removed.push({ channel, handler });
    },
  },
}));

import '../src/preload.js';
import { buildSilencePattern } from '../src/silence-pattern.js';
import type { DevBarApi } from '../src/ipc-contract.js';

function exposedApi(): DevBarApi {
  const api = ipc.exposed.get('api');
  if (!api) throw new Error('preload exposed nothing under "api"');
  return api as DevBarApi;
}

type Forward = readonly [
  label: string,
  call: (api: DevBarApi) => unknown,
  channel: string,
  args: readonly unknown[],
];

const FORWARDS: readonly Forward[] = [
  ['listGroups', (api) => api.listGroups(), 'groups:list', []],
  ['getGroupStates', (api) => api.getGroupStates(), 'groups:states', []],
  [
    'saveGroup',
    (api) => api.saveGroup({ id: 'g' }),
    'groups:save',
    [{ id: 'g' }],
  ],
  ['deleteGroup', (api) => api.deleteGroup('g1'), 'groups:delete', ['g1']],
  [
    'reorderGroups',
    (api) => api.reorderGroups(['g2', 'g1']),
    'groups:reorder',
    [['g2', 'g1']],
  ],
  [
    'saveCommand',
    (api) => api.saveCommand('g1', { id: 'c1' }),
    'commands:save',
    [{ groupId: 'g1', commandData: { id: 'c1' } }],
  ],
  [
    'deleteCommand',
    (api) => api.deleteCommand('g1', 'c1'),
    'commands:delete',
    [{ groupId: 'g1', commandId: 'c1' }],
  ],
  [
    'reorderCommands',
    (api) => api.reorderCommands('g1', ['c2', 'c1']),
    'commands:reorder',
    [{ groupId: 'g1', commandIds: ['c2', 'c1'] }],
  ],
  [
    'setCommandAutoStart',
    (api) => api.setCommandAutoStart('g1', 'c1', true),
    'commands:setAutoStart',
    [{ groupId: 'g1', commandId: 'c1', enabled: true }],
  ],
  [
    'saveAction',
    (api) => api.saveAction('g1', { id: 'a1' }),
    'actions:save',
    [{ groupId: 'g1', actionData: { id: 'a1' } }],
  ],
  [
    'deleteAction',
    (api) => api.deleteAction('g1', 'a1'),
    'actions:delete',
    [{ groupId: 'g1', actionId: 'a1' }],
  ],
  [
    'reorderActions',
    (api) => api.reorderActions('g1', ['a2', 'a1']),
    'actions:reorder',
    [{ groupId: 'g1', actionIds: ['a2', 'a1'] }],
  ],
  [
    'runAction',
    (api) => api.runAction('g1', 'a1'),
    'actions:run',
    [{ groupId: 'g1', actionId: 'a1' }],
  ],
  ['startProcess', (api) => api.startProcess('p1'), 'process:start', ['p1']],
  ['stopProcess', (api) => api.stopProcess('p1'), 'process:stop', ['p1']],
  ['listBranches', (api) => api.listBranches('g1'), 'git:listBranches', ['g1']],
  [
    'currentBranch',
    (api) => api.currentBranch('g1'),
    'git:currentBranch',
    ['g1'],
  ],
  [
    'switchBranch',
    (api) => api.switchBranch('g1', 'main'),
    'git:switchBranch',
    [{ groupId: 'g1', branch: 'main' }],
  ],
  [
    'addSilencePattern',
    (api) => api.addSilencePattern('g1', 'c1', 'warn', 'noise'),
    'silence:add',
    [{ groupId: 'g1', commandId: 'c1', level: 'warn', pattern: 'noise' }],
  ],
  [
    'removeSilencePattern',
    (api) => api.removeSilencePattern('g1', 'c1', 'error', 'noise'),
    'silence:remove',
    [{ groupId: 'g1', commandId: 'c1', level: 'error', pattern: 'noise' }],
  ],
  [
    'setCommandSilence',
    (api) => api.setCommandSilence('g1', 'c1', 'warn', false),
    'silence:setCommand',
    [{ groupId: 'g1', commandId: 'c1', level: 'warn', enabled: false }],
  ],
  [
    'setGroupSilence',
    (api) => api.setGroupSilence('g1', 'error', true),
    'silence:setGroup',
    [{ groupId: 'g1', level: 'error', enabled: true }],
  ],
  ['getLogs', (api) => api.getLogs('p1'), 'logs:get', ['p1']],
  ['getMergedLogs', (api) => api.getMergedLogs('g1'), 'logs:getMerged', ['g1']],
  [
    'getMergedSources',
    (api) => api.getMergedSources(null),
    'logs:getMergedSources',
    [null],
  ],
  ['clearLogs', (api) => api.clearLogs('p1'), 'logs:clear', ['p1']],
  ['listLogs', (api) => api.listLogs(), 'logs:list', []],
  ['isDev', (api) => api.isDev(), 'app:isDev', []],
  [
    'dev.simulateUpdate',
    (api) => api.dev.simulateUpdate('9.9.9'),
    'dev:simulateUpdate',
    [{ version: '9.9.9' }],
  ],
  [
    'dev.simulateRealUpdate',
    (api) => api.dev.simulateRealUpdate(),
    'dev:simulateRealUpdate',
    [],
  ],
  ['dev.clearUpdate', (api) => api.dev.clearUpdate(), 'dev:clearUpdate', []],
  [
    'dev.simulateTrayColor',
    (api) => api.dev.simulateTrayColor('warn'),
    'dev:simulateTrayColor',
    [{ color: 'warn' }],
  ],
  [
    'dev.simulateTrayCount',
    (api) => api.dev.simulateTrayCount(14),
    'dev:simulateTrayCount',
    [{ count: 14 }],
  ],
  [
    'dev.simulateBanner',
    (api) => api.dev.simulateBanner(true),
    'dev:simulateBanner',
    [{ cta: true }],
  ],
  [
    'dev.simulateFallbackBanner',
    (api) => api.dev.simulateFallbackBanner(false),
    'dev:simulateFallbackBanner',
    [{ cta: false }],
  ],
  [
    'dev.simulateSuccess',
    (api) => api.dev.simulateSuccess(),
    'dev:simulateSuccess',
    [],
  ],
  [
    'dev.simulatePrescriptConfirm',
    (api) => api.dev.simulatePrescriptConfirm(),
    'dev:simulatePrescriptConfirm',
    [],
  ],
  [
    'dev.simulateToast',
    (api) => api.dev.simulateToast('error'),
    'dev:simulateToast',
    [{ kind: 'error' }],
  ],
  ['openConfig', (api) => api.openConfig(), 'window:openConfig', []],
  [
    'openConfigChangelog',
    (api) => api.openConfigChangelog(),
    'window:openConfigChangelog',
    [],
  ],
  ['hideTray', (api) => api.hideTray(), 'window:hideTray', []],
  [
    'openLogs',
    (api) => api.openLogs({ scope: 'all', level: 'warn' }),
    'window:openLogs',
    [{ scope: 'all', level: 'warn' }],
  ],
  [
    'openSilenced',
    (api) => api.openSilenced('g1', 'c1'),
    'window:openSilenced',
    [{ groupId: 'g1', commandId: 'c1' }],
  ],
  [
    'getSilencedForCommand',
    (api) => api.getSilencedForCommand('g1', 'c1'),
    'silenced:getForCommand',
    [{ groupId: 'g1', commandId: 'c1' }],
  ],
  ['setTrayHeight', (api) => api.setTrayHeight(420), 'tray:setHeight', [420]],
  ['getSettings', (api) => api.getSettings(), 'settings:get', []],
  [
    'saveSettings',
    (api) => api.saveSettings({ theme: 'dark' }),
    'settings:save',
    [{ theme: 'dark' }],
  ],
  [
    'testNotification',
    (api) => api.testNotification(),
    'notifications:test',
    [],
  ],
  [
    'dismissNotification',
    (api) => api.dismissNotification(),
    'notification:dismiss',
    [],
  ],
  [
    'notificationAction',
    (api) => api.notificationAction('open-about'),
    'notification:action',
    ['open-about'],
  ],
  ['getUpdateStatus', (api) => api.getUpdateStatus(), 'updates:status', []],
  ['checkForUpdates', (api) => api.checkForUpdates(), 'updates:check', []],
  ['applyUpdate', (api) => api.applyUpdate(), 'updates:apply', []],
  ['getIconBattery', (api) => api.getIconBattery(), 'icons:get', []],
  ['exportConfig', (api) => api.exportConfig(), 'config:export', []],
  ['importConfig', (api) => api.importConfig(), 'config:import', []],
  [
    'confirmImport',
    (api) =>
      api.confirmImport({
        preview: {
          groupsCount: 1,
          commandsCount: 0,
          actionsCount: 0,
          preStepsCount: 0,
          preScriptsCount: 0,
          hasGlobalSettings: true,
        },
      }),
    'config:confirmImport',
    [
      {
        preview: {
          groupsCount: 1,
          commandsCount: 0,
          actionsCount: 0,
          preStepsCount: 0,
          preScriptsCount: 0,
          hasGlobalSettings: true,
        },
      },
    ],
  ],
  [
    'applyImportedConfig',
    (api) => api.applyImportedConfig({ token: 't1' }),
    'config:applyImport',
    [{ token: 't1' }],
  ],
  [
    'pickFolder',
    (api) => api.pickFolder('/repos'),
    'dialog:pickFolder',
    [{ defaultPath: '/repos' }],
  ],
  ['runPreScripts', (api) => api.runPreScripts(), 'prescripts:run', []],
  [
    'cancelPreScripts',
    (api) => api.cancelPreScripts(),
    'prescripts:cancel',
    [],
  ],
  ['getPreSteps', (api) => api.getPreSteps(), 'pipeline:list', []],
  [
    'savePreStep',
    (api) => api.savePreStep({ id: 's1' }),
    'preSteps:save',
    [{ data: { id: 's1' } }],
  ],
  [
    'deletePreStep',
    (api) => api.deletePreStep('s1'),
    'preSteps:delete',
    [{ stepId: 's1' }],
  ],
  [
    'reorderPreSteps',
    (api) => api.reorderPreSteps(['s2', 's1']),
    'preSteps:reorder',
    [{ orderedIds: ['s2', 's1'] }],
  ],
  [
    'savePreScript',
    (api) => api.savePreScript('g1', { id: 'sc1' }),
    'preScripts:save',
    [{ groupId: 'g1', data: { id: 'sc1' } }],
  ],
  [
    'deletePreScript',
    (api) => api.deletePreScript('g1', 'sc1'),
    'preScripts:delete',
    [{ groupId: 'g1', scriptId: 'sc1' }],
  ],
  [
    'reorderPreScripts',
    (api) => api.reorderPreScripts('g1', ['sc2', 'sc1']),
    'preScripts:reorder',
    [{ groupId: 'g1', orderedIds: ['sc2', 'sc1'] }],
  ],
  [
    'assignScriptToStep',
    (api) => api.assignScriptToStep('s1', 'g1', 'sc1', 2),
    'preSteps:assignScript',
    [{ stepId: 's1', groupId: 'g1', scriptId: 'sc1', position: 2 }],
  ],
  [
    'unassignScriptFromStep',
    (api) => api.unassignScriptFromStep('s1', 'g1', 'sc1'),
    'preSteps:unassignScript',
    [{ stepId: 's1', groupId: 'g1', scriptId: 'sc1' }],
  ],
  ['getPipelineState', (api) => api.getPipelineState(), 'pipeline:state', []],
  [
    'getPrescriptConfirmContext',
    (api) => api.getPrescriptConfirmContext('tok'),
    'prescriptConfirm:getContext',
    ['tok'],
  ],
  [
    'resolvePrescriptConfirm',
    (api) => api.resolvePrescriptConfirm('tok', 'cancel'),
    'prescriptConfirm:resolve',
    [{ token: 'tok', decision: 'cancel' }],
  ],
  ['quit', (api) => api.quit(), 'app:quit', []],
  ['getAppVersion', (api) => api.getAppVersion(), 'app:version', []],
  ['getChangelog', (api) => api.getChangelog(), 'updates:changelog', []],
  [
    'openExternal',
    (api) => api.openExternal('https://example.invalid'),
    'app:openExternal',
    ['https://example.invalid'],
  ],
  ['reportIssue', (api) => api.reportIssue(), 'app:reportIssue', []],
  ['copyReport', (api) => api.copyReport(), 'app:copyReport', []],
  [
    'openNotificationSettings',
    (api) => api.openNotificationSettings(),
    'app:openNotificationSettings',
    [],
  ],
  [
    'confirmDirty',
    (api) => api.confirmDirty('group'),
    'config:confirmDirty',
    [{ context: 'group' }],
  ],
  [
    'confirmCloseConfig',
    (api) => api.confirmCloseConfig(),
    'window:confirmCloseConfig',
    [],
  ],
];

type SubscriptionCase = readonly [
  label: string,
  subscribe: (api: DevBarApi, cb: (payload: unknown) => void) => () => void,
  channel: string,
];

const SUBSCRIPTIONS: readonly SubscriptionCase[] = [
  ['onConfigGoto', (api, cb) => api.onConfigGoto(cb), 'config:goto'],
  ['onUpdateStatus', (api, cb) => api.onUpdateStatus(cb), 'updates:status'],
  [
    'onPipelineUpdate',
    (api, cb) => api.onPipelineUpdate(cb),
    'pipeline:update',
  ],
  ['onUpdate', (api, cb) => api.onUpdate(cb), 'groups:update'],
  ['onThemeChange', (api, cb) => api.onThemeChange(cb), 'settings:theme'],
  ['onLog', (api, cb) => api.onLog(cb), 'logs:line'],
  ['onLogsSelect', (api, cb) => api.onLogsSelect(cb), 'logs:select'],
  [
    'onBranchesChanged',
    (api, cb) => api.onBranchesChanged(cb),
    'branches:changed',
  ],
  ['onActionDone', (api, cb) => api.onActionDone(cb), 'action:done'],
  ['onToast', (api, cb) => api.onToast(cb), 'groups:toast'],
];

describe('src/preload.ts', () => {
  beforeEach(() => {
    ipc.invokes.length = 0;
    ipc.on.length = 0;
    ipc.removed.length = 0;
  });

  describe('the bridge itself', () => {
    it('exposes the api under exactly one global name', () => {
      expect([...ipc.exposed.keys()]).toEqual(['api']);
    });

    it('publishes the platform as a value, not an IPC call', () => {
      expect(exposedApi().platform).toBe(process.platform);
      expect(ipc.invokes).toEqual([]);
    });

    it('shares the real silence-pattern builder rather than a channel', () => {
      const line = 'ERROR  something went wrong';

      expect(exposedApi().buildSilencePattern(line)).toBe(
        buildSilencePattern(line),
      );
      expect(ipc.invokes).toEqual([]);
    });
  });

  describe('channel forwarding', () => {
    it.each(FORWARDS)(
      '%s forwards to its own channel with its own payload',
      (_label, call, channel, args) => {
        call(exposedApi());

        expect(ipc.invokes).toEqual([{ channel, args: [...args] }]);
      },
    );

    it('passes an omitted optional argument through as undefined', () => {
      exposedApi().dev.simulateUpdate();

      expect(ipc.invokes).toEqual([
        { channel: 'dev:simulateUpdate', args: [{ version: undefined }] },
      ]);
    });

    it('covers every channel exactly once across the table', () => {
      const channels = FORWARDS.map(([, , channel]) => channel);

      expect(new Set(channels).size).toBe(channels.length);
    });
  });

  describe('push subscriptions', () => {
    it.each(SUBSCRIPTIONS)(
      '%s listens on its own channel and hands back only the payload',
      (_label, subscribe, channel) => {
        const seen: unknown[] = [];
        const dispose = subscribe(exposedApi(), (payload) =>
          seen.push(payload),
        );

        expect(ipc.on.map((entry) => entry.channel)).toEqual([channel]);
        const registered = ipc.on[0];
        if (!registered) throw new Error('nothing was registered');
        registered.handler({ sender: 'main' }, { value: 1 });
        // The IpcRendererEvent must NOT reach the renderer's callback: it
        // carries `sender`, a live handle back into the main process.
        expect(seen).toEqual([{ value: 1 }]);

        dispose();
        expect(ipc.removed).toEqual([{ channel, handler: registered.handler }]);
      },
    );

    it('registers onConfigCloseRequested with a payload-free callback', () => {
      let calls = 0;
      const dispose = exposedApi().onConfigCloseRequested(() => {
        calls += 1;
      });

      expect(ipc.on.map((entry) => entry.channel)).toEqual([
        'config:closeRequested',
      ]);
      const registered = ipc.on[0];
      if (!registered) throw new Error('nothing was registered');
      registered.handler({ sender: 'main' }, { ignored: true });
      expect(calls).toBe(1);

      dispose();
      expect(ipc.removed).toEqual([
        { channel: 'config:closeRequested', handler: registered.handler },
      ]);
    });

    it('gives every subscriber its own handler so one disposer cannot unhook another', () => {
      const api = exposedApi();
      const disposeFirst = api.onToast(() => undefined);
      api.onToast(() => undefined);

      expect(ipc.on).toHaveLength(2);
      disposeFirst();

      expect(ipc.removed).toEqual([
        { channel: 'groups:toast', handler: ipc.on[0]?.handler },
      ]);
    });
  });
});
