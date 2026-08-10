import type {
  Action,
  Group,
  LogEntry,
  PreScript,
  PreStep,
} from './domain-types.js';
import { makeAggregatorId, makePreScriptId } from './compound-id.js';
import { formatUptime } from './format-uptime.js';

interface ConfigStoreLike {
  getGroup(groupId: string): Group | null;
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

interface RunnerDeps {
  processManager: PreScriptProcessManager;
  configStore: ConfigStoreLike;
  broadcastUpdate: () => void;
  onError?: (
    error: string,
    context: { groupId: string; runId?: number },
  ) => void;
  onSuccess?: (context: {
    groupId: string;
    group: Group;
    runId: number;
  }) => void;
  confirmScript?: (
    script: PreScript,
    group: Group | null,
    groupId: string,
  ) => Promise<boolean>;
  cancelConfirm?: (groupId: string) => void;
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
  | { ok: true; runId?: number }
  | { ok: false; error: string; cancelled?: boolean };
interface OneResult {
  ok: boolean;
  code: number | null;
  error?: string | undefined;
  cancelled?: boolean;
}
export interface PreScriptRunner {
  run(groupId: string): Promise<RunResult>;
  cancel(groupId: string): { ok: boolean; error?: string | undefined };
  isRunning(groupId: string): boolean;
  getRunState(groupId: string): {
    status: RunnerStatus;
    currentStep: number;
    totalSteps: number;
    runId: number;
    aggregatorId: string;
    startedAt: number;
  } | null;
  getRecentResult(groupId: string): RecentResult | null;
  running: Map<string, RunHandle>;
}

export function createPreScriptRunner({
  processManager,
  configStore,
  broadcastUpdate,
  onError,
  onSuccess,
  confirmScript,
  cancelConfirm,
}: RunnerDeps): PreScriptRunner {
  const running = new Map<string, RunHandle>();
  const recentResult = new Map<string, RecentResult>();
  const pushAggregatorLog = (
    aggregatorId: string,
    line: string,
    level: 'warn' | 'error' | null = null,
  ): void =>
    processManager.pushLog(aggregatorId, {
      ts: Date.now(),
      stream: 'sys',
      level,
      line,
    });
  function setRecentResult(
    groupId: string,
    status: 'done' | 'error',
    error: string | null,
    runId: number,
    delayMs: number,
  ): void {
    const expiresAt = Date.now() + delayMs;
    recentResult.set(groupId, { status, error, runId, expiresAt });
    setTimeout(() => {
      const entry = recentResult.get(groupId);
      if (entry?.runId === runId) {
        recentResult.delete(groupId);
        broadcastUpdate();
      }
    }, delayMs);
  }

  async function runOne(
    script: PreScript,
    step: PreStep,
    groupId: string,
    handle: RunHandle,
  ): Promise<OneResult> {
    if (script.confirm) {
      const group = configStore.getGroup(groupId);
      const confirmed = confirmScript
        ? await confirmScript(script, group, groupId)
        : false;
      if (!confirmed) {
        pushAggregatorLog(
          handle.aggregatorId,
          `── Script "${script.name}" cancelado por el usuario ──`,
        );
        return {
          ok: false,
          code: -1,
          error: 'confirm_declined',
          cancelled: true,
        };
      }
    }
    const pid = makePreScriptId(groupId, step.id, script.id);
    handle.childPids.add(pid);
    const tag = `[${script.name}]`;
    return new Promise<OneResult>((resolve) => {
      const logHandler = ({
        id,
        entry,
      }: {
        id: string;
        entry: LogEntry;
      }): void => {
        if (id !== pid || entry.stream === 'sys') return;
        pushAggregatorLog(
          handle.aggregatorId,
          `${tag} ${entry.line}`,
          entry.level,
        );
      };
      processManager.on('log', logHandler);
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
        processManager.removeListener('log', logHandler);
        handle.childPids.delete(pid);
        const elapsed = formatUptime(Date.now() - scriptStartedAt),
          ok = code === 0;
        if (!handle._timedOutScripts.has(pid))
          pushAggregatorLog(
            handle.aggregatorId,
            ok
              ? `── Script "${script.name}" finished ok (${elapsed}) ──`
              : `── Script "${script.name}" failed (exit ${code}, ${elapsed}) ──`,
            ok ? null : 'error',
          );
        resolve({ ok, code });
      };
      processManager.on('action:done', handler);
      if (script.timeoutMs) {
        timeoutToken = setTimeout(() => {
          pushAggregatorLog(
            handle.aggregatorId,
            `── Script "${script.name}" timed out (${formatUptime(Date.now() - scriptStartedAt)}) ──`,
            'error',
          );
          handle._timedOutScripts.add(pid);
          void processManager.stop(pid);
        }, script.timeoutMs);
      }
      const result = processManager.start(pid);
      if (!result.ok) {
        if (timeoutToken) {
          clearTimeout(timeoutToken);
          timeoutToken = null;
        }
        processManager.removeListener('action:done', handler);
        processManager.removeListener('log', logHandler);
        handle.childPids.delete(pid);
        pushAggregatorLog(
          handle.aggregatorId,
          `── Script "${script.name}" failed to start: ${result.error ?? 'unknown error'} ──`,
          'error',
        );
        resolve({ ok: false, code: -1, error: result.error });
      }
    });
  }

  async function run(groupId: string): Promise<RunResult> {
    if (running.has(groupId)) return { ok: false, error: 'already_running' };
    const group = configStore.getGroup(groupId);
    if (!group) return { ok: false, error: 'group_not_found' };
    const steps = group.preSteps;
    if (!steps.length) return { ok: true };
    const groupPath = group.path.trim();
    if (!groupPath) {
      const runId = Date.now(),
        aggregatorId = makeAggregatorId(groupId, runId);
      pushAggregatorLog(
        aggregatorId,
        `── Pipeline aborted: group "${group.name}" has no path configured ──`,
        'error',
      );
      setRecentResult(
        groupId,
        'error',
        'Group has no path configured',
        runId,
        5000,
      );
      broadcastUpdate();
      onError?.('Group has no path configured', { groupId });
      return { ok: false, error: 'no_group_path' };
    }
    const runId = Date.now(),
      aggregatorId = makeAggregatorId(groupId, runId),
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
    running.set(groupId, handle);
    broadcastUpdate();
    pushAggregatorLog(
      aggregatorId,
      `── Pipeline started (${steps.length} steps) ──`,
    );
    pushAggregatorLog(aggregatorId, `── Working directory: ${groupPath} ──`);
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
        `── Step ${index + 1}/${steps.length} (${step.mode}) starting ──`,
      );
      const stepStartedAt = Date.now();
      let stepOk = false;
      if (step.mode === 'serial') {
        stepOk = true;
        for (const script of step.scripts) {
          if (handle.cancelled) {
            stepOk = false;
            break;
          }
          const result = await runOne(script, step, groupId, handle);
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
          step.scripts.map((script) => runOne(script, step, groupId, handle)),
        );
        if (
          results.some((result) => result.cancelled) &&
          results.every((result) => result.ok || result.cancelled)
        )
          pipelineCancelled = true;
        stepOk = results.every((result) => result.ok);
      }
      if (stepOk && !handle.cancelled)
        pushAggregatorLog(
          aggregatorId,
          `── Step ${index + 1} completed (${formatUptime(Date.now() - stepStartedAt)}) ──`,
        );
      if (!stepOk || handle.cancelled) {
        pipelineOk = false;
        failedStepIdx = index + 1;
        break;
      }
    }
    running.delete(groupId);
    const duration = formatUptime(Date.now() - handle.runId);
    if (!pipelineOk) {
      if (pipelineCancelled || handle.cancelled) {
        pushAggregatorLog(
          aggregatorId,
          `── Pipeline cancelled (${duration}) ──`,
        );
        handle.status = 'idle';
        broadcastUpdate();
        return { ok: false, cancelled: true, error: 'cancelled' };
      }
      const reason = `step_${failedStepIdx}_failed`;
      pushAggregatorLog(
        aggregatorId,
        `── Pipeline failed at step ${failedStepIdx} (${duration}) ──`,
        'error',
      );
      handle.status = 'error';
      setRecentResult(groupId, 'error', reason, runId, 5000);
      broadcastUpdate();
      onError?.(reason, { groupId, runId });
      return { ok: false, error: reason };
    }
    handle.status = 'done';
    pushAggregatorLog(aggregatorId, `── Pipeline complete (${duration}) ──`);
    setRecentResult(groupId, 'done', null, runId, 3000);
    broadcastUpdate();
    onSuccess?.({ groupId, group, runId });
    return { ok: true, runId };
  }
  function cancel(groupId: string): {
    ok: boolean;
    error?: string | undefined;
  } {
    const handle = running.get(groupId);
    if (!handle) return { ok: false, error: 'not_running' };
    handle.cancelled = true;
    for (const pid of handle.childPids) void processManager.stop(pid);
    cancelConfirm?.(groupId);
    return { ok: true };
  }
  const isRunning = (groupId: string): boolean => running.has(groupId);
  function getRunState(groupId: string) {
    const handle = running.get(groupId);
    return handle
      ? {
          status: handle.status,
          currentStep: handle.currentStep,
          totalSteps: handle.totalSteps,
          runId: handle.runId,
          aggregatorId: handle.aggregatorId,
          startedAt: handle.runId,
        }
      : null;
  }
  function getRecentResult(groupId: string): RecentResult | null {
    const entry = recentResult.get(groupId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      recentResult.delete(groupId);
      return null;
    }
    return entry;
  }
  return { run, cancel, isRunning, getRunState, getRecentResult, running };
}
