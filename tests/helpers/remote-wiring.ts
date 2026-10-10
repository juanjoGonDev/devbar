import { EventEmitter } from 'node:events';
import type { RemoteAppWiring } from '../../src/main/remote/runtime.js';
import { createConfirmQueue } from '../../src/main/confirm-queue.js';
import { createWindowRegistry } from '../../src/main/renderer-bus.js';
import type { GlobalSettings } from '../../src/domain-types.js';
import { makeGroup, makeSettings, makeState } from './main-fakes.js';

/**
 * The slice of main.ts's collaborators «Control remoto» is built from, as
 * inert fakes: one group at /repo, settings in memory, a real confirmation
 * queue and window registry. `calls` records the side effects worth
 * asserting; `events` is the process manager's emitter.
 */
export function fakeAppWiring() {
  const calls: string[] = [];
  const events = new EventEmitter();
  let settings = makeSettings();
  const registry = createWindowRegistry(() => null);
  const wiring: RemoteAppWiring = {
    host: { applyAutostart: (on) => calls.push(`autostart:${on}`) },
    configStore: {
      getGroup: (id) => (id === 'g1' ? makeGroup({ path: '/repo' }) : null),
      listGroups: () => [makeGroup()],
      getGlobalSettings: () => settings,
      saveGlobalSettings: (patch: Partial<GlobalSettings>) => {
        settings = { ...settings, ...patch };
        return settings;
      },
    },
    processManager: {
      start: () => ({ ok: true }),
      stop: () => Promise.resolve({ ok: true }),
      getState: (id) => makeState({ id }),
      getLogs: () => [
        { ts: 1, seq: 4, stream: 'stdout', level: null, line: 'x' },
      ],
      getLogSeq: () => 4,
      on: (event, listener) => events.on(event, listener),
    },
    preScriptRunner: { run: () => Promise.resolve(null) },
    gitManager: {
      listBranches: () => Promise.resolve({ ok: true, branches: [] }),
      currentBranch: (repo) => Promise.resolve({ ok: true, branch: repo }),
      switchBranch: () => Promise.resolve({ ok: true }),
      refreshRemotes: () => Promise.resolve({ changed: false }),
    },
    confirms: createConfirmQueue({
      openWindow: () => ({ isDestroyed: () => false, close: () => undefined }),
      logo: () => '',
    }),
    groupErrors: new Map(),
    broadcast: () => calls.push('broadcast'),
    branchesChanged: () => undefined,
    snapshots: {
      snapshotGroupStates: () => [],
      snapshotPipelineState: () => ({
        status: 'idle',
        currentStep: null,
        totalSteps: 0,
        lastError: null,
        lastRunId: null,
        startedAt: null,
      }),
    },
    updater: {
      status: () => ({
        available: null,
        staged: null,
        lastCheckAt: null,
        currentVersion: '0.11.0',
        phase: { state: 'idle' },
      }),
      canInstallStaged: () => false,
      installStagedHeadless: () => Promise.resolve({ ok: false }),
    },
    repaintWindows: () => calls.push('repaint'),
    sendTheme: (theme) => calls.push(`theme:${theme}`),
    registry,
  };
  return { wiring, calls, events, registry };
}
