import { describe, expect, it } from 'vitest';
import {
  groupViews,
  logLine,
  remoteWorkflowVisible,
  settingsView,
  updateView,
  workflowViews,
} from '../src/main/remote/views.js';
import type { GroupState, WorkflowEntry } from '../src/ipc-contract.js';
import type { Workflow, WorkflowTrigger } from '../src/domain-types.js';
import { graph } from './helpers/pipeline.js';
import type { UpdateStatus } from '../src/ipc-contract/updates-api.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeSettings,
} from './helpers/main-fakes.js';

const SECRET = 'hunter2-secret-token';

function groupState(): GroupState {
  const group = makeGroup({
    id: 'g1',
    name: 'Backend',
    path: '/Users/ana/secret-project',
    env: [{ key: 'API_KEY', value: SECRET, enabled: true }],
    commands: [
      makeCommand({
        id: 'api',
        name: 'API',
        env: [{ key: 'DB_PASSWORD', value: SECRET, enabled: true }],
      }),
    ],
    actions: [
      makeAction({
        id: 'seed',
        name: 'Seed',
        env: [{ key: 'TOKEN', value: SECRET, enabled: true }],
      }),
    ],
  });
  return {
    groupId: 'g1',
    group,
    currentBranch: null,
    color: 'warn',
    lastError: null,
    commands: [
      {
        commandId: 'api',
        processId: 'cmd:g1:api',
        status: 'running',
        warnCount: 2,
        errorCount: 0,
        lastError: null,
        startedAt: 1000,
        color: 'warn',
        muteWarn: false,
        muteErr: false,
      },
    ],
    actions: [
      {
        actionId: 'seed',
        processId: 'act:g1:seed',
        status: 'idle',
        lastExitCode: 1,
        lastFinishedAt: 900,
        startedAt: null,
      },
    ],
  };
}

const status = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  available: null,
  staged: null,
  lastCheckAt: null,
  currentVersion: '0.11.0',
  phase: { state: 'idle' },
  ...overrides,
});

const available = {
  version: '0.12.0',
  url: 'https://example.invalid',
  dmgUrl: null,
  zipUrl: null,
  setupUrl: null,
  appImageUrl: null,
  debUrl: null,
} as unknown as NonNullable<UpdateStatus['available']>;

describe('src/main/remote/views.ts', () => {
  describe('groupViews', () => {
    it('keeps what the panel paints, with the branch from the cache', () => {
      const [view] = groupViews(
        [groupState()],
        new Map([['g1', 'main']]),
        true,
      );

      expect(view).toEqual({
        id: 'g1',
        name: 'Backend',
        color: 'warn',
        branch: 'main',
        lastError: null,
        hidden: false,
        commands: [
          {
            id: 'api',
            processId: 'cmd:g1:api',
            name: 'API',
            status: 'running',
            color: 'warn',
            warnCount: 2,
            errorCount: 0,
            lastError: null,
            startedAt: 1000,
          },
        ],
        actions: [
          {
            id: 'seed',
            processId: 'act:g1:seed',
            name: 'Seed',
            status: 'idle',
            lastExitCode: 1,
            startedAt: null,
          },
        ],
      });
    });

    it('never carries an env value, a path or the env keys', () => {
      const json = JSON.stringify(groupViews([groupState()], new Map(), true));

      expect(json).not.toContain(SECRET);
      expect(json).not.toContain('secret-project');
      expect(json).not.toContain('API_KEY');
      expect(json).not.toContain('"env"');
    });

    it('has no branch for a group the cache does not know', () => {
      expect(groupViews([groupState()], new Map(), true)[0]?.branch).toBeNull();
    });

    it('lists the groups hidden from the tray last, flagged, like its fold', () => {
      const hidden = groupState();
      hidden.groupId = 'g0';
      hidden.group = { ...hidden.group, id: 'g0', hiddenInTray: true };

      const views = groupViews([hidden, groupState()], new Map(), true);

      expect(views.map((view) => [view.id, view.hidden])).toEqual([
        ['g1', false],
        ['g0', true],
      ]);
    });

    it('leaves the hidden groups out when the tray does not fold them', () => {
      const hidden = groupState();
      hidden.groupId = 'g0';
      hidden.group = { ...hidden.group, id: 'g0', hiddenInTray: true };

      const views = groupViews([hidden, groupState()], new Map(), false);

      expect(views.map((view) => view.id)).toEqual(['g1']);
    });

    it('falls back to the id when a runtime entry outlived its config', () => {
      const state = groupState();
      state.group = { ...state.group, commands: [], actions: [] };

      const [view] = groupViews([state], new Map(), true);

      expect(view?.commands[0]?.name).toBe('api');
      expect(view?.actions[0]?.name).toBe('seed');
    });
  });

  describe('workflowViews', () => {
    const MANUAL: WorkflowTrigger = { kind: 'manual', confirm: false };
    const SCHEDULE: WorkflowTrigger = {
      kind: 'schedule',
      schedule: { rules: [], interval: null },
    };
    const workflow = (
      id: string,
      trigger: WorkflowTrigger,
      hidden = false,
      enabled = true,
    ): Workflow => ({
      id,
      name: `Flujo ${id}`,
      enabled,
      hidden,
      trigger,
      graph: graph(['A'], ['trigger>A']),
    });
    const entry = (w: Workflow): WorkflowEntry => ({
      workflow: w,
      lastRun: null,
      nextRunAt: null,
      scriptCount: 1,
      running: null,
    });

    it('lists what the tray lists, the hidden ones last and flagged', () => {
      const views = workflowViews(
        [
          entry(workflow('cron', SCHEDULE)),
          entry(workflow('desk', MANUAL, true)),
          entry(workflow('off', MANUAL, false, false)),
          entry(workflow('start', { kind: 'startup' })),
        ],
        true,
      );
      expect(views.map((view) => [view.id, view.hidden])).toEqual([
        ['start', false],
        ['cron', false],
        ['desk', true],
      ]);
    });

    it('leaves the hidden ones out when the tray does not fold them', () => {
      const views = workflowViews(
        [entry(workflow('desk', MANUAL, true)), entry(workflow('m', MANUAL))],
        false,
      );
      expect(views.map((view) => view.id)).toEqual(['m']);
      expect(
        remoteWorkflowVisible(entry(workflow('desk', MANUAL, true)), false),
      ).toBe(false);
      expect(
        remoteWorkflowVisible(entry(workflow('desk', MANUAL, true)), true),
      ).toBe(true);
    });

    it('shows a running workflow even when it is hidden or off', () => {
      const running = {
        ...entry(workflow('desk', MANUAL, true, false)),
        running: { runId: 1, doneScripts: 0, totalScripts: 1, startedAt: 1 },
      };
      expect(remoteWorkflowVisible(running, false)).toBe(true);
      expect(workflowViews([running], false)).toMatchObject([
        { id: 'desk', hidden: false },
      ]);
    });

    it('carries only the name, the progress and the last result — never the graph', () => {
      const [view] = workflowViews(
        [
          {
            ...entry(workflow('start', { kind: 'startup' })),
            lastRun: {
              startedAt: 1,
              finishedAt: 9,
              durationMs: 8,
              result: 'warning',
            },
            running: {
              runId: 4,
              doneScripts: 3,
              totalScripts: 8,
              startedAt: 2,
            },
          },
        ],
        true,
      );
      expect(view).toEqual({
        id: 'start',
        name: 'Flujo start',
        startup: true,
        trigger: 'startup',
        running: true,
        hidden: false,
        doneScripts: 3,
        totalScripts: 8,
        startedAt: 2,
        nextRunAt: null,
        lastResult: 'warning',
        lastFinishedAt: 9,
      });
    });

    it('says how each one fires, and when a scheduled one fires next', () => {
      const views = workflowViews(
        [
          { ...entry(workflow('cron', SCHEDULE)), nextRunAt: 42 },
          entry(workflow('desk', MANUAL)),
        ],
        false,
      );
      expect(
        views.map(({ id, trigger, nextRunAt, startedAt }) => ({
          id,
          trigger,
          nextRunAt,
          startedAt,
        })),
      ).toEqual([
        { id: 'desk', trigger: 'manual', nextRunAt: null, startedAt: null },
        { id: 'cron', trigger: 'schedule', nextRunAt: 42, startedAt: null },
      ]);
    });
  });

  describe('updateView', () => {
    it('is current when nothing newer is known', () => {
      expect(updateView(status(), false)).toEqual({
        currentVersion: '0.11.0',
        state: 'current',
        version: null,
      });
    });

    it('is ready only when a staged update can be swapped in', () => {
      const known = status({
        available,
        phase: { state: 'available', version: '0.12.0' },
      });

      expect(updateView(known, true).state).toBe('ready');
      expect(updateView(known, false)).toEqual({
        currentVersion: '0.11.0',
        state: 'manual',
        version: '0.12.0',
      });
    });

    it('is busy while a download or an install is under way', () => {
      const downloading = status({
        available,
        phase: {
          state: 'downloading',
          version: '0.12.0',
          received: 1,
          total: 2,
        },
      });

      expect(updateView(downloading, false).state).toBe('busy');
    });

    it('is restarting once the swap has been handed off', () => {
      const restarting = status({
        available,
        phase: { state: 'restarting', version: '0.12.0' },
      });

      expect(updateView(restarting, false)).toEqual({
        currentVersion: '0.11.0',
        state: 'restarting',
        version: '0.12.0',
      });
    });
  });

  describe('logLine', () => {
    it('strips ANSI escapes and keeps the level, time and position', () => {
      expect(
        logLine({
          ts: 5,
          seq: 9,
          stream: 'stderr',
          level: 'error',
          line: '\u001b[31mboom\u001b[0m',
        }),
      ).toEqual({ seq: 9, ts: 5, level: 'error', line: 'boom' });
    });

    it('counts a line with no position as the first one', () => {
      expect(
        logLine({ ts: 5, stream: 'sys', level: null, line: 'x' }).seq,
      ).toBe(0);
    });
  });

  describe('settingsView', () => {
    it('shows only the four settings a phone may change', () => {
      expect(
        settingsView(makeSettings({ autostart: true, theme: 'dark' })),
      ).toEqual({
        autostart: true,
        notifySuccess: true,
        silenceWarnings: false,
        silenceErrors: false,
      });
    });
  });
});
