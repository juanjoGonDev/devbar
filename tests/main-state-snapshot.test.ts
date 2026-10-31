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
  ProcessState,
  Workflow,
  WorkflowRunRecord,
} from '../src/domain-types.js';
import type { WorkflowRunState } from '../src/ipc-contract.js';
import { graph } from './helpers/pipeline.js';

interface Harness {
  groups: Group[];
  settings: GlobalSettings;
  workflows: Workflow[];
  runs: Record<string, WorkflowRunRecord>;
  scheduleState: Record<string, string>;
  runStates: Map<string, WorkflowRunState>;
  states: Map<string, ProcessState>;
  groupErrors: Map<string, string | null>;
  now: number;
}

function harness(overrides: Partial<Harness> = {}) {
  const state: Harness = {
    groups: [],
    settings: makeSettings(),
    workflows: [],
    runs: {},
    scheduleState: {},
    runStates: new Map(),
    states: new Map(),
    groupErrors: new Map(),
    now: new Date(2026, 0, 5, 9, 0).getTime(),
    ...overrides,
  };
  const snapshots = createStateSnapshots({
    configStore: {
      listGroups: () => state.groups,
      getGlobalSettings: () => state.settings,
      listWorkflows: () => state.workflows,
      getWorkflowRuns: () => state.runs,
      getScheduleLastRun: (id) => state.scheduleState[id] ?? null,
    },
    processManager: {
      getState: (id) => state.states.get(id) ?? makeState({ id }),
    },
    workflowRunner: {
      runState: (id) => state.runStates.get(id) ?? null,
      isRunning: (id) => state.runStates.get(id)?.status === 'running',
    },
    groupErrors: state.groupErrors,
    now: () => state.now,
  });
  return { state, snapshots };
}

function workflow(id: string, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: id,
    enabled: true,
    hidden: false,
    trigger: {
      kind: 'manual',
      confirm: false,
    },
    graph: graph(['A', 'B'], ['trigger>A', 'A>B']),
    ...extra,
  };
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

  describe('workflowEntries', () => {
    it('lists each workflow with its runnable script count and last run', () => {
      const run: WorkflowRunRecord = {
        startedAt: 1,
        finishedAt: 3,
        durationMs: 2,
        result: 'warning',
      };
      const { snapshots } = harness({
        workflows: [workflow('w1'), workflow('w2')],
        runs: { w1: run },
      });
      expect(snapshots.workflowEntries()).toEqual([
        {
          workflow: workflow('w1'),
          lastRun: run,
          nextRunAt: null,
          scriptCount: 2,
          running: null,
        },
        {
          workflow: workflow('w2'),
          lastRun: null,
          nextRunAt: null,
          scriptCount: 2,
          running: null,
        },
      ]);
    });

    it('carries the progress of the run in flight', () => {
      const { snapshots } = harness({
        workflows: [workflow('w1')],
        runStates: new Map([
          [
            'w1',
            {
              workflowId: 'w1',
              runId: 7,
              aggregatorId: 'pre-pipeline:7',
              status: 'running',
              blocks: [],
              scripts: [],
              doneScripts: 1,
              totalScripts: 2,
              startedAt: 5,
              finishedAt: null,
            },
          ],
        ]),
      });
      expect(snapshots.workflowEntries()[0]?.running).toEqual({
        runId: 7,
        doneScripts: 1,
        totalScripts: 2,
        startedAt: 5,
      });
    });

    it('says when an enabled scheduled workflow fires next', () => {
      const scheduled = workflow('w1', {
        trigger: {
          kind: 'schedule',
          schedule: { rules: [{ time: '23:30', days: [] }], interval: null },
        },
      });
      const { snapshots, state } = harness({ workflows: [scheduled] });
      expect(snapshots.workflowEntries()[0]?.nextRunAt).toBe(
        new Date(2026, 0, 5, 23, 30).getTime(),
      );
      state.workflows = [{ ...scheduled, enabled: false }];
      expect(snapshots.workflowEntries()[0]?.nextRunAt).toBeNull();
    });
  });
});
