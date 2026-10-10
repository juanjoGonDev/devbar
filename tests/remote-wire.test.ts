import { describe, expect, it } from 'vitest';
import {
  confirmsView,
  logBatch,
  noticeView,
  settingsView,
  stateView,
  updateView,
} from '../renderer/remote/wire.js';

const STATE = {
  now: 5,
  host: { name: 'Mac-de-Ana', version: '0.11.0' },
  groups: [
    {
      id: 'g1',
      name: 'Backend',
      color: 'warn',
      branch: 'main',
      lastError: null,
      commands: [
        {
          id: 'web',
          processId: 'cmd:g1:web',
          name: 'Web',
          status: 'running',
          color: 'warn',
          warnCount: 2,
          errorCount: 0,
          lastError: null,
          startedAt: 1,
        },
      ],
      actions: [
        {
          id: 'seed',
          processId: 'act:g1:seed',
          name: 'Seed',
          status: 'idle',
          lastExitCode: null,
          startedAt: null,
        },
      ],
    },
  ],
  pipeline: {
    status: 'idle',
    currentStep: null,
    totalSteps: 2,
    lastError: null,
  },
  update: { currentVersion: '0.11.0', state: 'ready', version: '0.12.0' },
  confirms: [
    {
      token: 't1',
      name: 'migrate',
      command: 'pnpm db:migrate',
      groupName: 'Backend',
      secs: 42,
      onTimeout: 'cancel',
      deadline: 47,
    },
  ],
};

describe('renderer/remote/wire.ts', () => {
  describe('stateView', () => {
    it('keeps a well-formed state as it is', () => {
      expect(stateView(STATE)).toEqual(STATE);
    });

    it('turns nonsense into an empty, harmless state', () => {
      expect(stateView('nope')).toEqual({
        now: 0,
        host: { name: '', version: '' },
        groups: [],
        pipeline: {
          status: 'idle',
          currentStep: null,
          totalSteps: 0,
          lastError: null,
        },
        update: { currentVersion: '', state: 'current', version: null },
        confirms: [],
      });
    });

    it('drops malformed entries and falls back on unknown values', () => {
      const state = stateView({
        ...STATE,
        groups: [
          null,
          {
            id: 'g2',
            name: 'X',
            color: 'purple',
            commands: [{ id: 7 }, { id: 'c', status: 'weird', name: 'C' }],
          },
        ],
      });

      expect(state.groups).toHaveLength(1);
      expect(state.groups[0]?.color).toBe('stopped');
      expect(state.groups[0]?.commands).toEqual([
        {
          id: 'c',
          processId: '',
          name: 'C',
          status: 'stopped',
          color: 'stopped',
          warnCount: 0,
          errorCount: 0,
          lastError: null,
          startedAt: null,
        },
      ]);
    });
  });

  describe('confirmsView', () => {
    it('reads the pending list of a confirm event', () => {
      expect(confirmsView({ now: 3, confirms: STATE.confirms })).toEqual({
        now: 3,
        confirms: STATE.confirms,
      });
      expect(confirmsView(null)).toEqual({ now: 0, confirms: [] });
    });
  });

  describe('noticeView', () => {
    it('reads a notice, or nothing', () => {
      const notice = { id: 1, ts: 2, kind: 'error', title: 'a', body: 'b' };
      expect(noticeView(notice)).toEqual(notice);
      expect(noticeView({ ...notice, kind: 'odd' })?.kind).toBe('info');
      expect(noticeView({ id: 'x' })).toBeNull();
    });
  });

  describe('logBatch', () => {
    it('reads the id and its lines', () => {
      expect(
        logBatch({
          id: 'cmd:g1:web',
          lines: [{ seq: 1, ts: 2, level: 'warn', line: 'x' }, { seq: 'bad' }],
        }),
      ).toEqual({
        id: 'cmd:g1:web',
        lines: [{ seq: 1, ts: 2, level: 'warn', line: 'x' }],
      });
    });
  });

  describe('updateView / settingsView', () => {
    it('reads the update summary and the four switches', () => {
      expect(updateView(STATE.update)).toEqual(STATE.update);
      expect(
        settingsView({
          autostart: true,
          notifySuccess: false,
          silenceWarnings: 'x',
        }),
      ).toEqual({
        autostart: true,
        notifySuccess: false,
        silenceWarnings: false,
        silenceErrors: false,
      });
    });
  });
});
