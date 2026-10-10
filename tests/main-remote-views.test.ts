import { describe, expect, it } from 'vitest';
import {
  groupViews,
  logLine,
  pipelineView,
  settingsView,
  updateView,
} from '../src/main/remote/views.js';
import type { GroupState, PipelineState } from '../src/ipc-contract.js';
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
      const [view] = groupViews([groupState()], new Map([['g1', 'main']]));

      expect(view).toEqual({
        id: 'g1',
        name: 'Backend',
        color: 'warn',
        branch: 'main',
        lastError: null,
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
      const json = JSON.stringify(groupViews([groupState()], new Map()));

      expect(json).not.toContain(SECRET);
      expect(json).not.toContain('secret-project');
      expect(json).not.toContain('API_KEY');
      expect(json).not.toContain('"env"');
    });

    it('has no branch for a group the cache does not know', () => {
      expect(groupViews([groupState()], new Map())[0]?.branch).toBeNull();
    });

    it('falls back to the id when a runtime entry outlived its config', () => {
      const state = groupState();
      state.group = { ...state.group, commands: [], actions: [] };

      const [view] = groupViews([state], new Map());

      expect(view?.commands[0]?.name).toBe('api');
      expect(view?.actions[0]?.name).toBe('seed');
    });
  });

  describe('pipelineView', () => {
    it('drops the run id the phone has no log view for', () => {
      const pipeline: PipelineState = {
        status: 'running',
        currentStep: 1,
        totalSteps: 3,
        lastError: null,
        lastRunId: '7',
        startedAt: 5,
      };

      expect(pipelineView(pipeline)).toEqual({
        status: 'running',
        currentStep: 1,
        totalSteps: 3,
        lastError: null,
      });
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
