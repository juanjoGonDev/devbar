import { describe, expect, it, vi } from 'vitest';
import { createScheduleRunner } from '../src/main/schedule-runner.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeState,
} from './helpers/main-fakes.js';
import type {
  Group,
  ProcessState,
  Schedule,
  Workflow,
} from '../src/domain-types.js';
import { graph } from './helpers/pipeline.js';

const EVERY_DAY: Schedule = {
  enabled: true,
  rules: [{ time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }],
  interval: null,
};

function harness(groups: Group[] = [], workflows: Workflow[] = []) {
  const lastRuns = new Map<string, string>();
  const workflowRuns: string[] = [];
  const runningWorkflows = new Set<string>();
  const states = new Map<string, ProcessState>();
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: { id: string; line: string }[] = [];
  const timers: { fn: () => void; ms: number; repeating: boolean }[] = [];
  const broadcast = vi.fn();
  const confirmIfNeeded = vi.fn<() => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  let startThrows = false;
  const runner = createScheduleRunner({
    configStore: {
      listGroups: () => groups,
      listWorkflows: () => workflows,
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
      pushLog: (id, entry) => logs.push({ id, line: entry.line }),
    },
    confirmIfNeeded,
    broadcast,
    workflowRunner: {
      isRunning: (id) => runningWorkflows.has(id),
      run: (id, cause) => {
        workflowRuns.push(`${id}:${cause}`);
        return new Promise(() => undefined);
      },
    },
    setTimer: (fn, ms) => timers.push({ fn, ms, repeating: false }),
    setRepeatingTimer: (fn, ms) => timers.push({ fn, ms, repeating: true }),
    now: () => 1_000_000_000_000,
  });
  return {
    runner,
    lastRuns,
    workflowRuns,
    runningWorkflows,
    states,
    started,
    stopped,
    logs,
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
/** «Cada 15 minutos, de 9:00 a 18:00», the rules kept but ignored. */
const EVERY_15: Schedule = {
  enabled: true,
  rules: [{ time: '09:05', days: [] }],
  interval: {
    every: 15,
    unit: 'minutes',
    window: { from: '09:00', to: '18:00' },
    days: [],
  },
};
const local = (h: number, m: number, d = 4): Date =>
  new Date(2026, 4, d, h, m, 0, 0);

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
          { enabled: false, rules: [], interval: null },
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

  describe('interval («Cada…») schedules', () => {
    const api = (): Group =>
      makeGroup({
        commands: [makeCommand({ id: 'web', schedule: EVERY_15 })],
      });

    it('fires a command on the computed times, not on the kept rules', async () => {
      const h = harness([api()]);
      h.lastRuns.set('cmd:g1:web', local(9, 0).toISOString());
      await h.runner.checkSchedules(local(9, 5));
      expect(h.started).toEqual([]);
      await h.runner.checkSchedules(local(9, 15));
      expect(h.started).toEqual(['cmd:g1:web']);
      expect(h.lastRuns.get('cmd:g1:web')).toBe(local(9, 15).toISOString());
    });

    it('fires an action on the computed times', async () => {
      const group = makeGroup({
        actions: [makeAction({ id: 'pull', schedule: EVERY_15 })],
      });
      const h = harness([group]);
      h.lastRuns.set('act:g1:pull', local(9, 0).toISOString());
      await h.runner.checkSchedules(local(9, 15));
      expect(h.started).toEqual(['act:g1:pull']);
    });

    it('stays quiet outside the window', async () => {
      const h = harness([api()]);
      h.lastRuns.set('cmd:g1:web', local(18, 0).toISOString());
      await h.runner.checkSchedules(local(23, 30));
      expect(h.started).toEqual([]);
    });

    it('catches up at most ONE missed run after waking from sleep', async () => {
      const h = harness([api()]);
      // Asleep from 10:00 to 13:07: twelve runs missed.
      h.lastRuns.set('cmd:g1:web', local(10, 0).toISOString());
      await h.runner.checkSchedules(local(13, 7));
      expect(h.started).toEqual(['cmd:g1:web']);
      h.states.set('cmd:g1:web', makeState({ status: 'stopped' }));
      await h.runner.checkSchedules(local(13, 8));
      expect(h.started).toEqual(['cmd:g1:web']);
      await h.runner.checkSchedules(local(13, 15));
      expect(h.started).toEqual(['cmd:g1:web', 'cmd:g1:web']);
    });

    it('skips a run that is still going, with a log line, and never queues it', async () => {
      const h = harness([api()]);
      h.lastRuns.set('cmd:g1:web', local(9, 0).toISOString());
      h.states.set('cmd:g1:web', makeState({ status: 'running' }));
      await h.runner.checkSchedules(local(9, 15));
      expect(h.started).toEqual([]);
      expect(h.logs).toEqual([
        {
          id: 'cmd:g1:web',
          line: expect.stringContaining('saltada: sigue en marcha') as string,
        },
      ]);
      // It ends at 09:16: the skipped 09:15 run does not fire late.
      h.states.set('cmd:g1:web', makeState({ status: 'stopped' }));
      await h.runner.checkSchedules(local(9, 16));
      expect(h.started).toEqual([]);
      await h.runner.checkSchedules(local(9, 30));
      expect(h.started).toEqual(['cmd:g1:web']);
    });

    it('logs nothing when a due rule-mode target simply starts', async () => {
      const group = makeGroup({
        commands: [makeCommand({ id: 'web', schedule: EVERY_DAY })],
      });
      const h = harness([group]);
      h.lastRuns.set('cmd:g1:web', BEFORE);
      await h.runner.checkSchedules(AT);
      expect(h.logs).toEqual([]);
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
          pushLog: () => undefined,
        },
        confirmIfNeeded: () => Promise.resolve(true),
        broadcast: () => undefined,
      });
      expect(() => runner.startScheduleLoop()).not.toThrow();
    });
  });
  describe('scheduled workflows', () => {
    function scheduled(id: string, extra: Partial<Workflow> = {}): Workflow {
      return {
        id,
        name: id,
        enabled: true,
        hidden: false,
        trigger: {
          kind: 'schedule',
          schedule: { rules: [{ time: '09:00', days: [] }], interval: null },
        },
        graph: graph(['A'], ['trigger>A']),
        ...extra,
      };
    }

    it('seeds a workflow it sees for the first time instead of running it', async () => {
      const { runner, workflowRuns, lastRuns } = harness([], [scheduled('w1')]);
      await runner.checkSchedules(AT);
      expect(workflowRuns).toEqual([]);
      expect(lastRuns.get('wf:w1')).toBe(AT.toISOString());
    });

    it('runs a due workflow as a scheduled run, without waiting for it to end', async () => {
      const { runner, workflowRuns, lastRuns, broadcast } = harness(
        [],
        [scheduled('w1')],
      );
      lastRuns.set('wf:w1', BEFORE);
      await runner.checkSchedules(AT);
      expect(workflowRuns).toEqual(['w1:schedule']);
      expect(lastRuns.get('wf:w1')).toBe(AT.toISOString());
      expect(broadcast).toHaveBeenCalled();
    });

    it('fires an interval schedule on its anchored runs', async () => {
      const every: Workflow = scheduled('w1', {
        trigger: {
          kind: 'schedule',
          schedule: {
            rules: [],
            interval: { every: 30, unit: 'minutes', window: null, days: [] },
          },
        },
      });
      const { runner, workflowRuns, lastRuns } = harness([], [every]);
      lastRuns.set('wf:w1', new Date(2026, 4, 4, 9, 1).toISOString());
      await runner.checkSchedules(AT);
      expect(workflowRuns).toEqual([]);
      lastRuns.set('wf:w1', new Date(2026, 4, 4, 8, 59).toISOString());
      await runner.checkSchedules(AT);
      expect(workflowRuns).toEqual(['w1:schedule']);
    });

    it('honours the window and weekdays of a workflow interval', async () => {
      const office: Workflow = scheduled('w1', {
        trigger: {
          kind: 'schedule',
          schedule: {
            rules: [],
            interval: {
              every: 1,
              unit: 'hours',
              window: { from: '09:00', to: '18:00' },
              days: [1, 2, 3, 4, 5],
            },
          },
        },
      });
      const { runner, workflowRuns, lastRuns } = harness([], [office]);
      // 2026-05-09 is a Saturday: the whole day stays quiet.
      lastRuns.set('wf:w1', local(8, 0, 9).toISOString());
      await runner.checkSchedules(local(12, 0, 9));
      expect(workflowRuns).toEqual([]);
      // Monday 09:00 fires.
      await runner.checkSchedules(local(9, 0, 11));
      expect(workflowRuns).toEqual(['w1:schedule']);
    });

    it('skips a workflow still running when its run comes, with a log line', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { runner, workflowRuns, lastRuns, runningWorkflows } = harness(
        [],
        [scheduled('w1')],
      );
      lastRuns.set('wf:w1', BEFORE);
      runningWorkflows.add('w1');
      await runner.checkSchedules(AT);
      expect(workflowRuns).toEqual([]);
      expect(lastRuns.get('wf:w1')).toBe(AT.toISOString());
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('saltada: sigue en marcha'),
      );
      info.mockRestore();
    });

    it('leaves disabled, running and non-scheduled workflows alone', async () => {
      const manual: Workflow = {
        ...scheduled('w3'),
        trigger: {
          kind: 'manual',
          confirm: false,
        },
      };
      const { runner, workflowRuns, lastRuns, runningWorkflows } = harness(
        [],
        [scheduled('w1', { enabled: false }), scheduled('w2'), manual],
      );
      for (const id of ['w1', 'w2', 'w3']) lastRuns.set(`wf:${id}`, BEFORE);
      runningWorkflows.add('w2');
      await runner.checkSchedules(AT);
      expect(workflowRuns).toEqual([]);
    });
  });
});
