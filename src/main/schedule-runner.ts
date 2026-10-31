import { isDue, isWorkflowScheduleDue } from '../scheduler.js';
import { makeActionId, makeCommandId } from '../compound-id.js';
import type {
  Action,
  Command,
  Group,
  ProcessState,
  Schedule,
  Workflow,
} from '../domain-types.js';

/** The `scheduleState` key a scheduled workflow's last run is kept under. */
export function workflowScheduleKey(workflowId: string): string {
  return `wf:${workflowId}`;
}

/**
 * Anacron-style scheduler. Runs on a 60s tick, on power resume, and shortly
 * after startup. For each command with an enabled schedule:
 *   - first time we ever see it → seed lastRun=now (never fire retroactively
 *     for an occurrence that predates the user enabling the schedule).
 *   - otherwise, if a scheduled occurrence has elapsed since lastRun → start
 *     it.
 *
 * The lastRun bookkeeping (config-store.scheduleState) survives sleep AND app
 * restarts, so a machine asleep at 09:00 that wakes at 09:30 still catches up.
 * Unlike boot auto-start, scheduled commands do NOT execute pre-scripts; a
 * workflow with the `schedule` trigger is the scheduled way to run them, and
 * it follows the same bookkeeping (keyed `wf:<id>`) while it is enabled.
 */

interface ScheduleConfigStore {
  listGroups: () => Group[];
  listWorkflows?: () => Workflow[];
  getScheduleLastRun: (processId: string) => string | null;
  setScheduleLastRun: (processId: string, iso: string) => void;
}

interface ScheduleProcessManager {
  getState: (id: string) => Pick<ProcessState, 'status'>;
  start: (processId: string) => { ok: boolean; error?: string | undefined };
  stop: (id: string) => Promise<{ ok: boolean; error?: string | undefined }>;
}

export interface ScheduleRunnerDeps {
  configStore: ScheduleConfigStore;
  processManager: ScheduleProcessManager;
  confirmIfNeeded: (target: Command | Action, group: Group) => Promise<boolean>;
  broadcast: () => void;
  /** Runs the workflows with the `schedule` trigger, while enabled. */
  workflowRunner?: {
    isRunning: (workflowId: string) => boolean;
    run: (workflowId: string, cause: 'schedule') => Promise<unknown>;
  };
  setTimer?: (fn: () => void, ms: number) => unknown;
  setRepeatingTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
}

export interface ScheduleRunner {
  evaluateSchedule: (
    pid: string,
    sched: Schedule | null | undefined,
    now: Date,
    startFn: () => Promise<boolean>,
  ) => Promise<boolean>;
  checkSchedules: (now: Date) => Promise<void>;
  startScheduleLoop: () => void;
  /** True exactly once per scheduled action start, on its `action:done`. */
  claimScheduledAction: (processId: string) => boolean;
}

export function createScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
  const { configStore, processManager, confirmIfNeeded, broadcast } = deps;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const setRepeatingTimer =
    deps.setRepeatingTimer ?? ((fn, ms) => setInterval(fn, ms));
  const now = deps.now ?? (() => Date.now());

  // Action pids started by the scheduler, awaiting their action:done so we can
  // fire a completion notification (manual runs don't notify — you're
  // watching).
  const scheduledActionPids = new Set<string>();
  let schedulesInFlight = false;

  /**
   * Evaluate one schedulable target (command or action) at `now`. Seeds
   * lastRun on first sight (no retroactive fire), otherwise fires `startFn`
   * when a scheduled occurrence has elapsed since lastRun and it is not
   * already running. `startFn` must swallow its own errors.
   */
  async function evaluate(
    key: string,
    due: (lastRun: string) => boolean,
    at: Date,
    running: () => boolean,
    startFn: () => Promise<boolean>,
  ): Promise<boolean> {
    const last = configStore.getScheduleLastRun(key);
    if (last == null) {
      configStore.setScheduleLastRun(key, at.toISOString()); // seed only
      return false;
    }
    if (!due(last)) return false;
    let didStart = false;
    if (!running()) didStart = (await startFn()) === true;
    // Advance the marker even on a declined confirmation, so we don't re-prompt
    // for the same occurrence on every tick.
    configStore.setScheduleLastRun(key, at.toISOString());
    return didStart;
  }

  function evaluateSchedule(
    pid: string,
    sched: Schedule | null | undefined,
    at: Date,
    startFn: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!sched || !sched.enabled) return Promise.resolve(false);
    return evaluate(
      pid,
      (last) => isDue(sched, last, at),
      at,
      () => processManager.getState(pid).status === 'running',
      startFn,
    );
  }

  /**
   * Scheduled workflows. The run is kicked off, never awaited: a workflow
   * may take minutes, and the tick must not hold every other schedule (or
   * the re-entrancy guard) for that long.
   */
  async function runWorkflowSchedules(at: Date): Promise<boolean> {
    const runner = deps.workflowRunner;
    if (!runner || !configStore.listWorkflows) return false;
    let started = false;
    for (const workflow of configStore.listWorkflows()) {
      const { trigger } = workflow;
      if (trigger.kind !== 'schedule' || !workflow.enabled) continue;
      const ran = await evaluate(
        workflowScheduleKey(workflow.id),
        (last) => isWorkflowScheduleDue(trigger.schedule, last, at),
        at,
        () => runner.isRunning(workflow.id),
        () => {
          void runner.run(workflow.id, 'schedule');
          return Promise.resolve(true);
        },
      );
      started = started || ran;
    }
    return started;
  }

  async function runSchedulesOnce(at: Date): Promise<void> {
    let started = false;
    for (const group of configStore.listGroups()) {
      for (const cmd of group.commands || []) {
        const pid = makeCommandId(group.id, cmd.id);
        const ran = await evaluateSchedule(pid, cmd.schedule, at, async () => {
          if (!(await confirmIfNeeded(cmd, group))) return false;
          // Single-mode groups: stop other running commands first (radio).
          if (group.mode === 'single') {
            const others = (group.commands || [])
              .map((c) => makeCommandId(group.id, c.id))
              .filter(
                (p) =>
                  p !== pid && processManager.getState(p).status === 'running',
              );
            for (const p of others) await processManager.stop(p);
          }
          try {
            processManager.start(pid);
            return true;
          } catch (err) {
            console.error(`schedule start ${group.name}/${cmd.name}:`, err);
            return false;
          }
        });
        started = started || ran;
      }
      for (const act of group.actions || []) {
        const pid = makeActionId(group.id, act.id);
        const ran = await evaluateSchedule(pid, act.schedule, at, async () => {
          if (!(await confirmIfNeeded(act, group))) return false;
          try {
            processManager.start(pid);
            scheduledActionPids.add(pid); // notify on its action:done
            return true;
          } catch (err) {
            console.error(`schedule start ${group.name}/${act.name}:`, err);
            return false;
          }
        });
        started = started || ran;
      }
    }
    if (await runWorkflowSchedules(at)) started = true;
    if (started) broadcast();
  }

  // Re-entrancy guard: a scheduled start may await an indefinite confirmation
  // modal, so a tick/resume mid-run must not re-evaluate the still-due target
  // and queue another modal (or double-start it). One run at a time.
  async function checkSchedules(at: Date): Promise<void> {
    if (schedulesInFlight) return;
    schedulesInFlight = true;
    try {
      await runSchedulesOnce(at);
    } finally {
      schedulesInFlight = false;
    }
  }

  return {
    evaluateSchedule,
    checkSchedules,

    /**
     * Run checkSchedules aligned to the wall-clock minute. A plain
     * setInterval(60s) fires at an arbitrary phase (ready+1s, +61s, …), so a
     * 13:02 schedule could fire anywhere up to 13:02:59. We wait until the next
     * :00 second, then tick every 60s from there.
     */
    startScheduleLoop(): void {
      const msToNextMinute = 60000 - (now() % 60000);
      setTimer(() => {
        void checkSchedules(new Date());
        setRepeatingTimer(() => void checkSchedules(new Date()), 60 * 1000);
      }, msToNextMinute);
    },

    claimScheduledAction(processId: string): boolean {
      return scheduledActionPids.delete(processId);
    },
  };
}
