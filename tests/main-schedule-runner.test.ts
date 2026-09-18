import { describe, expect, it, vi } from 'vitest';
import { createScheduleRunner } from '../src/main/schedule-runner.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeState,
} from './helpers/main-fakes.js';
import type { Group, ProcessState, Schedule } from '../src/domain-types.js';

const EVERY_DAY: Schedule = {
  enabled: true,
  rules: [{ time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }],
};

function harness(groups: Group[] = []) {
  const lastRuns = new Map<string, string>();
  const states = new Map<string, ProcessState>();
  const started: string[] = [];
  const stopped: string[] = [];
  const timers: { fn: () => void; ms: number; repeating: boolean }[] = [];
  const broadcast = vi.fn();
  const confirmIfNeeded = vi.fn<() => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  let startThrows = false;
  const runner = createScheduleRunner({
    configStore: {
      listGroups: () => groups,
      getScheduleLastRun: (pid) => lastRuns.get(pid) ?? null,
      setScheduleLastRun: (pid, iso) => lastRuns.set(pid, iso),
    },
    processManager: {
      getState: (id) => states.get(id) ?? makeState({ id }),
      start: (pid) => {
        if (startThrows) throw new Error('spawn failed');
        started.push(pid);
        return { ok: true };
      },
      stop: (pid) => {
        stopped.push(pid);
        return Promise.resolve({ ok: true });
      },
    },
    confirmIfNeeded,
    broadcast,
    setTimer: (fn, ms) => timers.push({ fn, ms, repeating: false }),
    setRepeatingTimer: (fn, ms) => timers.push({ fn, ms, repeating: true }),
    now: () => 1_000_000_000_000,
  });
  return {
    runner,
    lastRuns,
    states,
    started,
    stopped,
    timers,
    broadcast,
    confirmIfNeeded,
    failStart: () => {
      startThrows = true;
    },
  };
}

// Local time on purpose: `mostRecentOccurrence` builds the occurrence with
// `setHours`, so a UTC literal would land on a different local hour and the
// occurrence would fall outside the window on most machines.
const AT = new Date(2026, 4, 4, 9, 5, 0, 0);
const BEFORE = new Date(2026, 4, 4, 8, 0, 0, 0).toISOString();

describe('src/main/schedule-runner.ts', () => {
  describe('evaluateSchedule', () => {
    it('ignores a target with no schedule or a disabled one', async () => {
      const { runner } = harness();
      const startFn = vi.fn(() => Promise.resolve(true));
      await expect(
        runner.evaluateSchedule('p', null, AT, startFn),
      ).resolves.toBe(false);
      await expect(
        runner.evaluateSchedule(
          'p',
          { enabled: false, rules: [] },
          AT,
          startFn,
        ),
      ).resolves.toBe(false);
      expect(startFn).not.toHaveBeenCalled();
    });

    it('seeds lastRun on first sight instead of firing retroactively', async () => {
      const { runner, lastRuns } = harness();
      const startFn = vi.fn(() => Promise.resolve(true));
      await expect(
        runner.evaluateSchedule('p', EVERY_DAY, AT, startFn),
      ).resolves.toBe(false);
      expect(lastRuns.get('p')).toBe(AT.toISOString());
      expect(startFn).not.toHaveBeenCalled();
    });

    it('fires once an occurrence has elapsed and advances the marker', async () => {
      const { runner, lastRuns } = harness();
      lastRuns.set('p', BEFORE);
      await expect(
        runner.evaluateSchedule('p', EVERY_DAY, AT, () =>
          Promise.resolve(true),
        ),
      ).resolves.toBe(true);
      expect(lastRuns.get('p')).toBe(AT.toISOString());
    });

    it('skips a target that is already running but still advances the marker', async () => {
      const { runner, lastRuns, states } = harness();
      lastRuns.set('p', BEFORE);
      states.set('p', makeState({ status: 'running' }));
      const startFn = vi.fn(() => Promise.resolve(true));
      await expect(
        runner.evaluateSchedule('p', EVERY_DAY, AT, startFn),
      ).resolves.toBe(false);
      expect(startFn).not.toHaveBeenCalled();
      expect(lastRuns.get('p')).toBe(AT.toISOString());
    });

    it('advances the marker after a declined confirmation, so it does not re-prompt', async () => {
      const { runner, lastRuns } = harness();
      lastRuns.set('p', BEFORE);
      await expect(
        runner.evaluateSchedule('p', EVERY_DAY, AT, () =>
          Promise.resolve(false),
        ),
      ).resolves.toBe(false);
      expect(lastRuns.get('p')).toBe(AT.toISOString());
    });

    it('leaves the marker alone when nothing is due', async () => {
      const { runner, lastRuns } = harness();
      const recent = new Date(2026, 4, 4, 9, 1, 0, 0).toISOString();
      lastRuns.set('p', recent);
      await runner.evaluateSchedule('p', EVERY_DAY, AT, () =>
        Promise.resolve(true),
      );
      expect(lastRuns.get('p')).toBe(recent);
    });
  });

  describe('checkSchedules', () => {
    it('starts a due command and broadcasts once', async () => {
      const group = makeGroup({
        commands: [makeCommand({ id: 'web', schedule: EVERY_DAY })],
      });
      const h = harness([group]);
      h.lastRuns.set('cmd:g1:web', BEFORE);
      await h.runner.checkSchedules(AT);
      expect(h.started).toEqual(['cmd:g1:web']);
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast when nothing fired', async () => {
      const h = harness([makeGroup({ commands: [makeCommand()] })]);
      await h.runner.checkSchedules(AT);
      expect(h.broadcast).not.toHaveBeenCalled();
    });

    it('stops the other running commands of a single-mode group first', async () => {
      const group = makeGroup({
        mode: 'single',
        commands: [
          makeCommand({ id: 'web', schedule: EVERY_DAY }),
          makeCommand({ id: 'api' }),
        ],
      });
      const h = harness([group]);
      h.lastRuns.set('cmd:g1:web', BEFORE);
      h.states.set('cmd:g1:api', makeState({ status: 'running' }));
      await h.runner.checkSchedules(AT);
      expect(h.stopped).toEqual(['cmd:g1:api']);
      expect(h.started).toEqual(['cmd:g1:web']);
    });

    it('never starts a command whose confirmation was declined', async () => {
      const group = makeGroup({
        commands: [
          makeCommand({ id: 'web', schedule: EVERY_DAY, confirm: true }),
        ],
      });
      const h = harness([group]);
      h.confirmIfNeeded.mockResolvedValue(false);
      h.lastRuns.set('cmd:g1:web', BEFORE);
      await h.runner.checkSchedules(AT);
      expect(h.started).toEqual([]);
    });

    it('swallows a failed command start and keeps going', async () => {
      const group = makeGroup({
        commands: [makeCommand({ id: 'web', schedule: EVERY_DAY })],
      });
      const h = harness([group]);
      h.failStart();
      h.lastRuns.set('cmd:g1:web', BEFORE);
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      await h.runner.checkSchedules(AT);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('remembers a scheduled action so its completion is announced once', async () => {
      const group = makeGroup({
        actions: [makeAction({ id: 'seed', schedule: EVERY_DAY })],
      });
      const h = harness([group]);
      h.lastRuns.set('act:g1:seed', BEFORE);
      await h.runner.checkSchedules(AT);
      expect(h.started).toEqual(['act:g1:seed']);
      expect(h.runner.claimScheduledAction('act:g1:seed')).toBe(true);
      expect(h.runner.claimScheduledAction('act:g1:seed')).toBe(false);
    });

    it('declines a scheduled action whose confirmation was refused', async () => {
      const group = makeGroup({
        actions: [
          makeAction({ id: 'seed', schedule: EVERY_DAY, confirm: true }),
        ],
      });
      const h = harness([group]);
      h.confirmIfNeeded.mockResolvedValue(false);
      h.lastRuns.set('act:g1:seed', BEFORE);
      await h.runner.checkSchedules(AT);
      expect(h.started).toEqual([]);
    });

    it('swallows a failed action start', async () => {
      const group = makeGroup({
        actions: [makeAction({ id: 'seed', schedule: EVERY_DAY })],
      });
      const h = harness([group]);
      h.failStart();
      h.lastRuns.set('act:g1:seed', BEFORE);
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      await h.runner.checkSchedules(AT);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('never runs twice at once', async () => {
      let release = (): void => undefined;
      const gate = new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
      const group = makeGroup({
        commands: [
          makeCommand({ id: 'web', schedule: EVERY_DAY, confirm: true }),
        ],
      });
      const h = harness([group]);
      h.confirmIfNeeded.mockReturnValue(gate);
      h.lastRuns.set('cmd:g1:web', BEFORE);
      const first = h.runner.checkSchedules(AT);
      await h.runner.checkSchedules(AT);
      expect(h.confirmIfNeeded).toHaveBeenCalledTimes(1);
      release();
      await first;
    });
  });

  describe('startScheduleLoop', () => {
    it('aligns the first tick to the next wall-clock minute, then ticks every 60s', () => {
      const h = harness();
      h.runner.startScheduleLoop();
      expect(h.timers[0]?.ms).toBe(60000 - (1_000_000_000_000 % 60000));
      h.timers[0]?.fn();
      expect(h.timers[1]).toMatchObject({ ms: 60000, repeating: true });
      h.timers[1]?.fn();
      expect(h.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('defaults', () => {
    it('falls back to the real timers and clock', () => {
      const runner = createScheduleRunner({
        configStore: {
          listGroups: () => [],
          getScheduleLastRun: () => null,
          setScheduleLastRun: () => undefined,
        },
        processManager: {
          getState: (id) => makeState({ id }),
          start: () => ({ ok: true }),
          stop: () => Promise.resolve({ ok: true }),
        },
        confirmIfNeeded: () => Promise.resolve(true),
        broadcast: () => undefined,
      });
      expect(() => runner.startScheduleLoop()).not.toThrow();
    });
  });
});
