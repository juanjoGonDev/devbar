import type { Group, PreScript, PreStepScriptRef } from './domain-types.js';
import { makeAggregatorId } from './compound-id.js';
import { formatUptime } from './format-uptime.js';
import { formatStepCount, formatStepMode } from './pipeline-labels.js';
import {
  runOne,
  type ConfigStoreLike,
  type OneResult,
  type PreScriptProcessManager,
  type RunHandle,
  type RunnerStatus,
} from './pre-script/run-one.js';

export type { PreScriptProcessManager } from './pre-script/run-one.js';

/** Fired synchronously, at most once per step, in ascending step order. */
export interface StepCompleteEvent {
  stepIndex: number;
  stepId: string;
  totalSteps: number;
  runId: number;
}

interface RunnerDeps {
  processManager: PreScriptProcessManager;
  configStore: ConfigStoreLike;
  broadcastUpdate: () => void;
  onStepComplete?: (event: StepCompleteEvent) => void;
  onError?: (
    error: string,
    context: { runId?: number; failedStepIndex?: number },
  ) => void;
  onSuccess?: (context: { runId: number; stepCount: number }) => void;
  confirmScript?: (
    script: PreScript,
    group: Group | null,
    groupId: string,
  ) => Promise<boolean>;
  cancelConfirm?: () => void;
}
interface RecentResult {
  status: 'done' | 'error';
  error: string | null;
  runId: number;
  expiresAt: number;
}
export type RunResult =
  | { ok: true; runId: number }
  | {
      ok: false;
      error: string;
      cancelled?: boolean;
      runId?: number;
      aggregatorId?: string;
    };
interface PipelineRunState {
  status: RunnerStatus;
  currentStep: number;
  totalSteps: number;
  runId: number;
  aggregatorId: string;
  startedAt: number;
}
export interface PreScriptRunner {
  run(): Promise<RunResult>;
  cancel(): { ok: boolean; error?: string | undefined };
  isRunning(): boolean;
  getRunState(): PipelineRunState | null;
  getRecentResult(): RecentResult | null;
  /** The in-flight `run()` promise, or `null` when idle. Lets a caller that
   * got `already_running` wait for the run already underway and adopt ITS
   * result, instead of treating another caller's run as a failure of its
   * own. */
  current(): Promise<RunResult> | null;
}

export function createPreScriptRunner({
  processManager,
  configStore,
  broadcastUpdate,
  onStepComplete,
  onError,
  onSuccess,
  confirmScript,
  cancelConfirm,
}: RunnerDeps): PreScriptRunner {
  // Singleton: one global pipeline, not one per group.
  let running: RunHandle | null = null;
  let recentResult: RecentResult | null = null;
  // The promise backing the in-flight `run()` call, or null when idle.
  // Exposed via `current()` so a caller who got `already_running` can await
  // the SAME run instead of misreporting it as its own failure.
  let currentRunPromise: Promise<RunResult> | null = null;
  const pushSysLog = (
    bufferId: string,
    line: string,
    level: 'warn' | 'error' | null = null,
  ): void =>
    processManager.pushLog(bufferId, {
      ts: Date.now(),
      stream: 'sys',
      level,
      line,
    });
  /** Pipeline-level narration: the run itself, never one script. */
  const pushAggregatorLog = pushSysLog;
  /**
   * Narration ABOUT one script goes into that script's OWN buffer, so the
   * merged view tags it `[Back] [Make setup]` from a real source instead of
   * attributing it to the pipeline. The tag now carries the identity, so the
   * message no longer repeats `Script "Grupo · Script"` in its text.
   */
  const pushScriptLog = pushSysLog;
  /** `runOne` with this runner's collaborators already bound. */
  const runScript = (
    ref: PreStepScriptRef,
    handle: RunHandle,
  ): Promise<OneResult> =>
    runOne(ref, handle, {
      processManager,
      configStore,
      pushAggregatorLog,
      pushScriptLog,
      confirmScript,
    });
  function setRecentResult(
    status: 'done' | 'error',
    error: string | null,
    runId: number,
    delayMs: number,
  ): void {
    const expiresAt = Date.now() + delayMs;
    recentResult = { status, error, runId, expiresAt };
    setTimeout(() => {
      if (recentResult?.runId === runId) {
        recentResult = null;
        broadcastUpdate();
      }
    }, delayMs);
  }

  /**
   * Thin guard + bookkeeping wrapper. The guard runs synchronously, exactly
   * as before, so a concurrent call still gets `already_running` immediately
   * (see the still-passing `returns already_running when called twice`
   * test). Once past the guard, `performRun`'s own promise is published via
   * `currentRunPromise` — read through `current()` — for the ENTIRE run,
   * cleared only once it settles, so a caller who awaits `current()` sees
   * exactly the same result this call resolves to.
   */
  async function run(): Promise<RunResult> {
    if (running) return { ok: false, error: 'already_running' };
    const runPromise = performRun();
    currentRunPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      currentRunPromise = null;
    }
  }

  async function performRun(): Promise<RunResult> {
    const steps = configStore.getPreSteps();
    if (!steps.length) return { ok: true, runId: Date.now() };
    const runId = Date.now(),
      aggregatorId = makeAggregatorId(runId),
      handle: RunHandle = {
        runId,
        aggregatorId,
        cancelled: false,
        childPids: new Set(),
        currentStep: 1,
        totalSteps: steps.length,
        status: 'running',
        _timedOutScripts: new Set(),
      };
    running = handle;
    broadcastUpdate();
    pushAggregatorLog(
      aggregatorId,
      `── Pipeline iniciado (${formatStepCount(steps.length)}) ──`,
    );
    let pipelineOk = true,
      pipelineCancelled = false,
      failedStepIdx = -1;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (!step) continue;
      handle.currentStep = index + 1;
      broadcastUpdate();
      if (handle.cancelled) {
        pipelineOk = false;
        pipelineCancelled = true;
        break;
      }
      pushAggregatorLog(
        aggregatorId,
        `── Paso ${index + 1}/${steps.length} (${formatStepMode(step.mode)}) iniciando ──`,
      );
      const stepStartedAt = Date.now();
      let stepOk = false;
      if (step.mode === 'serial') {
        stepOk = true;
        for (const ref of step.scripts) {
          if (handle.cancelled) {
            stepOk = false;
            break;
          }
          const result = await runScript(ref, handle);
          if (result.cancelled) {
            pipelineCancelled = true;
            stepOk = false;
            break;
          }
          if (!result.ok) {
            stepOk = false;
            break;
          }
        }
      } else {
        const results = await Promise.all(
          step.scripts.map((ref) => runScript(ref, handle)),
        );
        if (
          results.some((result) => result.cancelled) &&
          results.every((result) => result.ok || result.cancelled)
        )
          pipelineCancelled = true;
        stepOk = results.every((result) => result.ok);
      }
      if (stepOk && !handle.cancelled) {
        pushAggregatorLog(
          aggregatorId,
          `── Paso ${index + 1} completado (${formatUptime(Date.now() - stepStartedAt)}) ──`,
        );
        // Synchronous and non-awaited: every command released by this step
        // must be spawned before step N+1's first runOne. A throwing
        // callback is contained here so a main-process bug cannot abort the
        // pipeline (D3).
        try {
          onStepComplete?.({
            stepIndex: index,
            stepId: step.id,
            totalSteps: steps.length,
            runId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pushAggregatorLog(
            aggregatorId,
            `── Fallo en el aviso de fin de paso: ${message} ──`,
            'error',
          );
        }
      }
      if (!stepOk || handle.cancelled) {
        pipelineOk = false;
        failedStepIdx = index + 1;
        break;
      }
    }
    running = null;
    const duration = formatUptime(Date.now() - handle.runId);
    if (!pipelineOk) {
      if (pipelineCancelled || handle.cancelled) {
        pushAggregatorLog(
          aggregatorId,
          `── Pipeline cancelado (${duration}) ──`,
        );
        handle.status = 'idle';
        broadcastUpdate();
        return {
          ok: false,
          cancelled: true,
          error: 'cancelled',
          runId,
          aggregatorId,
        };
      }
      const reason = `step_${failedStepIdx}_failed`;
      pushAggregatorLog(
        aggregatorId,
        `── Pipeline fallido en el paso ${failedStepIdx} (${duration}) ──`,
        'error',
      );
      handle.status = 'error';
      setRecentResult('error', reason, runId, 5000);
      broadcastUpdate();
      onError?.(reason, { runId, failedStepIndex: failedStepIdx });
      return { ok: false, error: reason, runId, aggregatorId };
    }
    handle.status = 'done';
    pushAggregatorLog(aggregatorId, `── Pipeline completado (${duration}) ──`);
    setRecentResult('done', null, runId, 3000);
    broadcastUpdate();
    onSuccess?.({ runId, stepCount: steps.length });
    return { ok: true, runId };
  }
  function cancel(): { ok: boolean; error?: string | undefined } {
    if (!running) return { ok: false, error: 'not_running' };
    running.cancelled = true;
    for (const pid of running.childPids) void processManager.stop(pid);
    cancelConfirm?.();
    return { ok: true };
  }
  const isRunning = (): boolean => running !== null;
  function getRunState(): PipelineRunState | null {
    return running
      ? {
          status: running.status,
          currentStep: running.currentStep,
          totalSteps: running.totalSteps,
          runId: running.runId,
          aggregatorId: running.aggregatorId,
          startedAt: running.runId,
        }
      : null;
  }
  function getRecentResult(): RecentResult | null {
    if (!recentResult) return null;
    if (Date.now() > recentResult.expiresAt) {
      recentResult = null;
      return null;
    }
    return recentResult;
  }
  const current = (): Promise<RunResult> | null => currentRunPromise;
  return {
    run,
    cancel,
    isRunning,
    getRunState,
    getRecentResult,
    current,
  };
}
