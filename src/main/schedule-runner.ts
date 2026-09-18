import { isDue } from '../scheduler.js';
import { makeActionId, makeCommandId } from '../compound-id.js';
import type {
  Action,
  Command,
  Group,
  ProcessState,
  Schedule,
} from '../domain-types.js';

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
 * Unlike boot auto-start, scheduled runs do NOT execute pre-scripts.
 */

interface ScheduleConfigStore {
  listGroups: () => Group[];
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
  async function evaluateSchedule(
    pid: string,
    sched: Schedule | null | undefined,
    at: Date,
    startFn: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!sched || !sched.enabled) return false;
    const last = configStore.getScheduleLastRun(pid);
    if (last == null) {
      configStore.setScheduleLastRun(pid, at.toISOString()); // seed only
      return false;
    }
    if (!isDue(sched, last, at)) return false;
    let didStart = false;
    if (processManager.getState(pid).status !== 'running') {
      didStart = (await startFn()) === true;
    }
    // Advance the marker even on a declined confirmation, so we don't re-prompt
    // for the same occurrence on every tick.
    configStore.setScheduleLastRun(pid, at.toISOString());
    return didStart;
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
