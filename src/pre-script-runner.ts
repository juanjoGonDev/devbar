import type {
  Action,
  Group,
  LogEntry,
  PreScript,
  PreStep,
  PreStepScriptRef,
} from './domain-types.js';
import { makeAggregatorId, makePreScriptId } from './compound-id.js';
import { formatUptime } from './format-uptime.js';
import { formatStepCount, formatStepMode } from './pipeline-labels.js';

interface ConfigStoreLike {
  getGroup(groupId: string): Group | null;
  getPreSteps(): PreStep[];
}

export interface PreScriptProcessManager {
  pushLog(id: string, entry: LogEntry): void;
  on(
    event: 'log',
    listener: (payload: { id: string; entry: LogEntry }) => void,
  ): unknown;
  on(
    event: 'action:done',
    listener: (payload: {
      processId: string;
      code: number | null;
      group: Group;
      target: Action | PreScript;
    }) => void,
  ): unknown;
  removeListener(
    event: 'log',
    listener: (payload: { id: string; entry: LogEntry }) => void,
  ): unknown;
  removeListener(
    event: 'action:done',
    listener: (payload: {
      processId: string;
      code: number | null;
      group: Group;
      target: Action | PreScript;
    }) => void,
  ): unknown;
  start(processId: string): { ok: boolean; error?: string | undefined };
  stop(processId: string): Promise<{ ok: boolean; error?: string | undefined }>;
}

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
type RunnerStatus = 'running' | 'done' | 'error' | 'idle';
interface RunHandle {
  runId: number;
  aggregatorId: string;
  cancelled: boolean;
  childPids: Set<string>;
  currentStep: number;
  totalSteps: number;
  status: RunnerStatus;
  _timedOutScripts: Set<string>;
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
interface OneResult {
  ok: boolean;
  code: number | null;
  error?: string | undefined;
  cancelled?: boolean;
  skipped?: boolean;
}
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
   * Resolves `ref` against its OWN group for every run-time concern (script
   * definition, cwd, env) — never the step's or the pipeline's — since a
   * step can now mix refs from different groups. An unresolvable ref (a
   * dangling reference the write-time prune could not catch, e.g. hand-
   * edited JSON) is skipped with a warning rather than failing the step: a
   * leftover ref must not deadlock boot auto-start (D6).
   */
  async function runOne(
    ref: PreStepScriptRef,
    handle: RunHandle,
  ): Promise<OneResult> {
    const group = configStore.getGroup(ref.groupId);
    const script = group?.preScripts.find(
      (candidate) => candidate.id === ref.scriptId,
    );
    if (!group || !script) {
      pushAggregatorLog(
        handle.aggregatorId,
        `── Referencia rota (grupo o script inexistente), omitida ──`,
        'warn',
      );
      return { ok: true, code: null, skipped: true };
    }
    const pid = makePreScriptId(ref.groupId, script.id);
    const groupPath = group.path.trim();
    if (!groupPath) {
      // An ordinary per-script failure, not a whole-pipeline abort: siblings
      // already spawned in the same parallel step still complete.
      pushScriptLog(pid, `── Sin ruta configurada en su grupo ──`, 'error');
      return { ok: false, code: -1, error: 'no_group_path' };
    }
    if (script.confirm) {
      const confirmed = confirmScript
        ? await confirmScript(script, group, ref.groupId)
        : false;
      if (!confirmed) {
        pushScriptLog(pid, `── Cancelado por el usuario ──`);
        return {
          ok: false,
          code: -1,
          error: 'confirm_declined',
          cancelled: true,
        };
      }
    }
    handle.childPids.add(pid);
    return new Promise<OneResult>((resolve) => {
      let timeoutToken: NodeJS.Timeout | null = null;
      const scriptStartedAt = Date.now();
      const handler = ({
        processId,
        code,
      }: {
        processId: string;
        code: number | null;
      }): void => {
        if (processId !== pid) return;
        if (timeoutToken) {
          clearTimeout(timeoutToken);
          timeoutToken = null;
        }
        processManager.removeListener('action:done', handler);
        handle.childPids.delete(pid);
        const elapsed = formatUptime(Date.now() - scriptStartedAt),
          ok = code === 0;
        if (!handle._timedOutScripts.has(pid))
          pushScriptLog(
            pid,
            ok
              ? `── Finalizado correctamente (${elapsed}) ──`
              : `── Ha fallado (salida ${code}, ${elapsed}) ──`,
            ok ? null : 'error',
          );
        resolve({ ok, code });
      };
      processManager.on('action:done', handler);
      if (script.timeoutMs) {
        timeoutToken = setTimeout(() => {
          pushScriptLog(
            pid,
            `── Ha excedido el tiempo límite (${formatUptime(Date.now() - scriptStartedAt)}) ──`,
            'error',
          );
          handle._timedOutScripts.add(pid);
          void processManager.stop(pid);
        }, script.timeoutMs);
      }
      pushScriptLog(pid, `── Directorio: ${groupPath} ──`);
      const result = processManager.start(pid);
      if (!result.ok) {
        if (timeoutToken) {
          clearTimeout(timeoutToken);
          timeoutToken = null;
        }
        processManager.removeListener('action:done', handler);
        handle.childPids.delete(pid);
        pushScriptLog(
          pid,
          `── No ha podido arrancar: ${result.error ?? 'error desconocido'} ──`,
          'error',
        );
        resolve({ ok: false, code: -1, error: result.error });
      }
    });
  }

  async function run(): Promise<RunResult> {
    if (running) return { ok: false, error: 'already_running' };
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
          const result = await runOne(ref, handle);
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
          step.scripts.map((ref) => runOne(ref, handle)),
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
  return { run, cancel, isRunning, getRunState, getRecentResult };
}
