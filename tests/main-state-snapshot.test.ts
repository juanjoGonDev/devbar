import { describe, expect, it } from 'vitest';
import { createStateSnapshots } from '../src/main/state-snapshot.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeSettings,
  makeState,
} from './helpers/main-fakes.js';
import type {
  GlobalSettings,
  Group,
  PreStep,
  ProcessState,
} from '../src/domain-types.js';

interface Harness {
  groups: Group[];
  settings: GlobalSettings;
  preSteps: PreStep[];
  states: Map<string, ProcessState>;
  runState: {
    status: 'running' | 'done' | 'error' | 'idle';
    currentStep: number;
    totalSteps: number;
    runId: number;
    startedAt: number;
  } | null;
  recentResult: {
    status: 'done' | 'error';
    error: string | null;
    runId: number;
  } | null;
  groupErrors: Map<string, string | null>;
}

function harness(overrides: Partial<Harness> = {}) {
  const state: Harness = {
    groups: [],
    settings: makeSettings(),
    preSteps: [],
    states: new Map(),
    runState: null,
    recentResult: null,
    groupErrors: new Map(),
    ...overrides,
  };
  const snapshots = createStateSnapshots({
    configStore: {
      listGroups: () => state.groups,
      getGlobalSettings: () => state.settings,
      getPreSteps: () => state.preSteps,
    },
    processManager: {
      getState: (id) => state.states.get(id) ?? makeState({ id }),
    },
    preScriptRunner: {
      getRunState: () => state.runState,
      getRecentResult: () => state.recentResult,
    },
    groupErrors: state.groupErrors,
  });
  return { state, snapshots };
}

describe('src/main/state-snapshot.ts', () => {
  describe('snapshotGroupStates', () => {
    it('gives every command and action its compound process id', () => {
      const { snapshots } = harness({
        groups: [
          makeGroup({
            commands: [makeCommand({ id: 'web' })],
            actions: [makeAction({ id: 'install' })],
          }),
        ],
      });
      const [group] = snapshots.snapshotGroupStates();
      expect(group?.commands[0]?.processId).toBe('cmd:g1:web');
      expect(group?.actions[0]?.processId).toBe('act:g1:install');
    });

    it('reports a stopped group when nothing runs', () => {
      const { snapshots } = harness({
        groups: [makeGroup({ commands: [makeCommand()] })],
      });
      expect(snapshots.snapshotGroupStates()[0]?.color).toBe('stopped');
    });

    it('tints the group with the worst running command', () => {
      const { snapshots } = harness({
        groups: [
          makeGroup({
            commands: [makeCommand({ id: 'a' }), makeCommand({ id: 'b' })],
          }),
        ],
        states: new Map([
          ['cmd:g1:a', makeState({ status: 'running', warnCount: 1 })],
          ['cmd:g1:b', makeState({ status: 'running', errorCount: 2 })],
        ]),
      });
      expect(snapshots.snapshotGroupStates()[0]?.color).toBe('error');
    });

    it('settles on warn when no running command errored', () => {
      const { snapshots } = harness({
        groups: [makeGroup({ commands: [makeCommand({ id: 'a' })] })],
        states: new Map([
          ['cmd:g1:a', makeState({ status: 'running', warnCount: 1 })],
        ]),
      });
      expect(snapshots.snapshotGroupStates()[0]?.color).toBe('warn');
    });

    it('shows plain running for a clean service', () => {
      const { snapshots } = harness({
        groups: [makeGroup({ commands: [makeCommand({ id: 'a' })] })],
        states: new Map([['cmd:g1:a', makeState({ status: 'running' })]]),
      });
      expect(snapshots.snapshotGroupStates()[0]?.color).toBe('running');
    });

    it('surfaces a stopped command that died with an error', () => {
      const { snapshots } = harness({
        groups: [makeGroup({ commands: [makeCommand({ id: 'a' })] })],
        states: new Map([['cmd:g1:a', makeState({ lastError: 'exit 1' })]]),
      });
      expect(snapshots.snapshotGroupStates()[0]?.color).toBe('error');
    });

    it('marks a command muted when any of the three levels silences it', () => {
      const { snapshots } = harness({
        groups: [
          makeGroup({ commands: [makeCommand({ silenceWarnings: true })] }),
          makeGroup({
            id: 'g2',
            silenceErrors: true,
            commands: [makeCommand({ id: 'c2' })],
          }),
        ],
        settings: makeSettings(),
      });
      const [first, second] = snapshots.snapshotGroupStates();
      expect(first?.commands[0]?.muteWarn).toBe(true);
      expect(second?.commands[0]?.muteErr).toBe(true);
    });

    it('mutes everything when the global setting does', () => {
      const { snapshots } = harness({
        groups: [makeGroup({ commands: [makeCommand()] })],
        settings: makeSettings({ silenceWarnings: true, silenceErrors: true }),
      });
      const [group] = snapshots.snapshotGroupStates();
      expect(group?.commands[0]?.muteWarn).toBe(true);
      expect(group?.commands[0]?.muteErr).toBe(true);
    });

    it('carries the group-level transient error through', () => {
      const { snapshots } = harness({
        groups: [makeGroup()],
        groupErrors: new Map([['g1', 'git checkout failed']]),
      });
      expect(snapshots.snapshotGroupStates()[0]?.lastError).toBe(
        'git checkout failed',
      );
    });

    it('leaves the branch for the renderer to fetch', () => {
      const { snapshots } = harness({ groups: [makeGroup()] });
      expect(snapshots.snapshotGroupStates()[0]?.currentBranch).toBeNull();
    });

    it('reports an action that has never run as idle', () => {
      const { snapshots } = harness({
        groups: [makeGroup({ actions: [makeAction()] })],
        states: new Map([['act:g1:a1', makeState({ status: '' as never })]]),
      });
      expect(snapshots.snapshotGroupStates()[0]?.actions[0]?.status).toBe(
        'idle',
      );
    });
  });

  describe('snapshotPipelineState', () => {
    it('is idle with the configured step count when nothing has run', () => {
      const { snapshots } = harness({
        preSteps: [{ id: 's1', mode: 'serial', scripts: [] }],
      });
      expect(snapshots.snapshotPipelineState()).toMatchObject({
        status: 'idle',
        currentStep: null,
        totalSteps: 1,
        lastError: null,
        lastRunId: null,
        startedAt: null,
      });
    });

    it('reports the live run while one is in flight', () => {
      const { snapshots } = harness({
        runState: {
          status: 'running',
          currentStep: 2,
          totalSteps: 4,
          runId: 7,
          startedAt: 1000,
        },
      });
      expect(snapshots.snapshotPipelineState()).toMatchObject({
        status: 'running',
        currentStep: 2,
        totalSteps: 4,
        lastRunId: '7',
        startedAt: 1000,
      });
    });

    it('surfaces the error of a failed recent result', () => {
      const { snapshots } = harness({
        recentResult: { status: 'error', error: 'vpn failed', runId: 9 },
      });
      expect(snapshots.snapshotPipelineState()).toMatchObject({
        status: 'error',
        lastError: 'vpn failed',
        lastRunId: '9',
      });
    });

    it('carries no error for a successful recent result', () => {
      const { snapshots } = harness({
        recentResult: { status: 'done', error: null, runId: 9 },
      });
      expect(snapshots.snapshotPipelineState().lastError).toBeNull();
    });

    it('remembers the run id after the badge TTL clears it', () => {
      const { state, snapshots } = harness({
        recentResult: { status: 'done', error: null, runId: 9 },
      });
      snapshots.snapshotPipelineState();
      state.recentResult = null;
      expect(snapshots.snapshotPipelineState().lastRunId).toBe('9');
    });

    it('forgets the run id once the buffers are wiped', () => {
      const { state, snapshots } = harness({
        recentResult: { status: 'done', error: null, runId: 9 },
      });
      snapshots.snapshotPipelineState();
      state.recentResult = null;
      snapshots.forgetPipelineRunId();
      expect(snapshots.snapshotPipelineState().lastRunId).toBeNull();
    });
  });
});
