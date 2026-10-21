import type {
  Group,
  LogEntry,
  PipelineBlock,
  PreScript,
  PreStepScriptRef,
} from './domain-types.js';
import type { WorkflowRunState } from './ipc-contract.js';
import { makePreScriptId } from './compound-id.js';
import { formatUptime } from './format-uptime.js';
import { formatScriptCount } from './pipeline-labels.js';
import {
  blocksToSkip,
  pipelineRefKey,
  readyBlocks,
  runnableScriptCount,
} from './pipeline-graph.js';
import {
  runOne,
  type ConfigStoreLike,
  type PreScriptProcessManager,
  type RunHandle,
} from './pre-script/run-one.js';
import {
  appendScriptLog,
  failedScriptCount,
  freshRun,
  planRetry,
  resultOf,
  scriptStatusOf,
  setBlock,
  setScript,
  snapshotOf,
  type LiveRun,
} from './pre-script/run-state.js';

export type { PreScriptProcessManager } from './pre-script/run-one.js';

/**
 * Fired synchronously, at most once per block, when a block finished
 * successfully — and BEFORE any block waiting on it is started, so whatever
 * the callback releases is spawned first.
 */
export interface BlockCompleteEvent {
  blockId: string;
  runId: number;
}

interface RunnerDeps {
  processManager: PreScriptProcessManager;
  configStore: ConfigStoreLike;
  broadcastUpdate: () => void;
  /** Stamped on every snapshot; one runner runs one workflow. */
  workflowId?: string;
  /** The workflow's current name, for the narration. */
  name?: () => string;
  /** Run ids; defaults to `Date.now()`. Must never repeat across runners. */
  nextRunId?: () => number;
  onBlockComplete?: (event: BlockCompleteEvent) => void;
  onError?: (
    error: string,
    context: { runId?: number; failedScripts?: number },
  ) => void;
  onSuccess?: (context: {
    runId: number;
    scriptCount: number;
    /** It finished «con avisos». */
    warned: boolean;
  }) => void;
  /** Every finished run (or retry), whatever its result. */
  onFinish?: (state: WorkflowRunState) => void;
  confirmScript?:
    | ((
        script: PreScript,
        group: Group | null,
        groupId: string,
      ) => Promise<boolean>)
    | undefined;
  cancelConfirm?: (() => void) | undefined;
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
export interface PreScriptRunner {
  run(): Promise<RunResult>;
  /**
   * Re-runs `blockId` and every descendant that did not succeed in the last
   * run, keeping the blocks that did. A new run id, so a fresh narration log.
   */
  retryFrom(blockId: string): Promise<RunResult>;
  cancel(): { ok: boolean; error?: string | undefined };
  isRunning(): boolean;
  /** The latest run — in flight or finished — or null before the first. */
  getSnapshot(): WorkflowRunState | null;
  /** A script's own output during run `runId` (`'latest'`: the last one). */
  scriptLog(runId: number | 'latest', ref: PreStepScriptRef): LogEntry[] | null;
  /** The in-flight `run()` promise, or `null` when idle. Lets a caller that
   * got `already_running` wait for the run already underway and adopt ITS
   * result, instead of treating another caller's run as a failure of its
   * own. */
  current(): Promise<RunResult> | null;
}

/** How one block ended, for the scheduler. */
interface BlockOutcome {
  /** Whether what waits on it may start. */
  ok: boolean;
  /** A failure because of a declined confirmation only. */
  declined: boolean;
}

/**
 * One workflow's runner. Scheduling follows the DAG semantics of
 * src/pipeline-graph.ts: every block whose sources are all done starts at
 * once (its scripts in parallel), a failed block skips its descendants while
 * independent branches carry on, and the run ends when no block is running
 * and none is ready. A block with «Todos OK» (`requireAll`) fails as soon as
 * one script fails, stopping its siblings; without it the siblings carry on
 * and the block lets its descendants start anyway. The run fails if any block
 * failed; a declined confirmation (with no real failure) or a cancel ends it
 * as cancelled; a tolerated failure or a warning ends it «con avisos».
 */
export function createPreScriptRunner({
  processManager,
  configStore,
  broadcastUpdate,
  workflowId = '',
  name,
  nextRunId = () => Date.now(),
  onBlockComplete,
  onError,
  onSuccess,
  onFinish,
  confirmScript,
  cancelConfirm,
}: RunnerDeps): PreScriptRunner {
  /** The latest run, kept after it ends (statuses, logs, retry). */
  let live: LiveRun | null = null;
  let running: RunHandle | null = null;
  // The promise backing the in-flight run, or null when idle. Exposed via
  // `current()` so a caller who got `already_running` can await the SAME run
  // instead of misreporting it as its own failure.
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
  /** Workflow-level narration: the run itself, never one script. */
  const pushAggregatorLog = pushSysLog;
  /**
   * Narration ABOUT one script goes into that script's OWN buffer, so the
   * merged view tags it `[Back] [Make setup]` from a real source instead of
   * attributing it to the workflow.
   */
  const pushScriptLog = pushSysLog;
  const title = (): string => {
    const current = name?.();
    return current ? `Workflow «${current}»` : 'Workflow';
  };

  /** Runs one block's scripts together; settles each as it finishes. */
  async function runBlock(
    run: LiveRun,
    block: PipelineBlock,
  ): Promise<BlockOutcome> {
    const { handle } = run;
    pushAggregatorLog(
      handle.aggregatorId,
      `── ${run.labelOf(block.id)} iniciando (${formatScriptCount(block.scripts.length)}) ──`,
    );
    // «Todos OK»: the first failure stops the siblings still running, and
    // makes the ones still waiting on a confirmation give up.
    let abandoned = false;
    const stopped = new Set<string>();
    const results = await Promise.all(
      block.scripts.map((ref) => {
        const key = pipelineRefKey(ref);
        return runOne(ref, handle, {
          processManager,
          configStore,
          pushAggregatorLog,
          pushScriptLog,
          confirmScript,
          shouldAbort: () => handle.cancelled || abandoned,
          onStarted: () => {
            setScript(run, ref, { status: 'running', startedAt: Date.now() });
            broadcastUpdate();
          },
          onLog: (entry) => appendScriptLog(run, key, entry),
        }).then((result) => {
          handle.doneScripts += 1;
          const status = scriptStatusOf(
            result,
            stopped.has(key),
            handle.cancelled,
          );
          setScript(run, ref, {
            status,
            finishedAt: Date.now(),
            exitCode: result.code,
          });
          if (block.requireAll && !result.ok && !abandoned) {
            abandoned = true;
            for (const sibling of block.scripts) {
              const siblingKey = pipelineRefKey(sibling);
              if (run.scripts.get(siblingKey)?.status !== 'running') continue;
              stopped.add(siblingKey);
              void processManager.stop(
                makePreScriptId(sibling.groupId, sibling.scriptId),
              );
            }
          }
          broadcastUpdate();
          return { result, status };
        });
      }),
    );
    const statuses = results.map((entry) => entry.status);
    if (!block.requireAll) {
      const clean = statuses.every((status) => status === 'success');
      setBlock(run, block.id, {
        status: handle.cancelled ? 'cancelled' : clean ? 'success' : 'warning',
        finishedAt: Date.now(),
      });
      return { ok: !handle.cancelled, declined: false };
    }
    const ok = results.every((entry) => entry.result.ok);
    const failed = statuses.includes('error');
    setBlock(run, block.id, {
      status: ok
        ? statuses.includes('warning')
          ? 'warning'
          : 'success'
        : failed && !handle.cancelled
          ? 'error'
          : 'cancelled',
      finishedAt: Date.now(),
    });
    return { ok, declined: !ok && !failed };
  }

  /** Records how `block` ended: logs it, fires the hook or skips descendants. */
  function settleBlock(
    run: LiveRun,
    block: PipelineBlock,
    outcome: BlockOutcome,
    blockStartedAt: number,
  ): void {
    const { pipeline, internal, handle, labelOf } = run;
    const { aggregatorId, runId } = handle;
    if (outcome.ok) {
      internal.set(block.id, 'done');
      if (handle.cancelled) return;
      pushAggregatorLog(
        aggregatorId,
        `── ${labelOf(block.id)} completado (${formatUptime(Date.now() - blockStartedAt)}) ──`,
      );
      // Synchronous and non-awaited: every command released by this block
      // must be spawned before any block waiting on it starts. A throwing
      // callback is contained here so a main-process bug cannot abort the
      // run (D3).
      try {
        onBlockComplete?.({ blockId: block.id, runId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushAggregatorLog(
          aggregatorId,
          `── Fallo en el aviso de fin de bloque: ${message} ──`,
          'error',
        );
      }
      return;
    }
    internal.set(block.id, 'failed');
    if (!handle.cancelled && !outcome.declined)
      pushAggregatorLog(
        aggregatorId,
        `── ${labelOf(block.id)} fallido ──`,
        'error',
      );
    for (const id of blocksToSkip(pipeline, block.id, internal)) {
      internal.set(id, 'skipped');
      const skipped = pipeline.blocks.find((b) => b.id === id);
      if (!skipped) continue;
      // A cancel is why nothing more runs, not the failure it caused.
      const status = handle.cancelled ? 'cancelled' : 'skipped';
      setBlock(run, id, { status });
      for (const ref of skipped.scripts) setScript(run, ref, { status });
      handle.doneScripts += skipped.scripts.length;
      if (!handle.cancelled)
        pushAggregatorLog(
          aggregatorId,
          `── ${labelOf(id)} omitido (depende de un bloque que no terminó) ──`,
          'warn',
        );
    }
    broadcastUpdate();
  }

  /** Starts every ready block, again after each one settles, until idle. */
  function schedule(run: LiveRun): Promise<void> {
    const { pipeline, handle, internal } = run;
    return new Promise((resolve) => {
      let active = 0;
      const pump = (): void => {
        const ready = handle.cancelled ? [] : readyBlocks(pipeline, internal);
        for (const id of ready) {
          const block = pipeline.blocks.find((b) => b.id === id);
          if (!block) continue;
          internal.set(id, 'running');
          setBlock(run, id, { status: 'running', startedAt: Date.now() });
          active += 1;
          const blockStartedAt = Date.now();
          void runBlock(run, block).then((outcome) => {
            active -= 1;
            settleBlock(run, block, outcome, blockStartedAt);
            pump();
          });
        }
        if (ready.length > 0) broadcastUpdate();
        if (active === 0) resolve();
      };
      pump();
    });
  }

  async function execute(run: LiveRun, isRetry: boolean): Promise<RunResult> {
    const { handle } = run;
    const { runId, aggregatorId } = handle;
    live = run;
    running = handle;
    broadcastUpdate();
    pushAggregatorLog(
      aggregatorId,
      isRetry
        ? `── ${title()}: reintento (${formatScriptCount(handle.totalScripts - handle.doneScripts)}) ──`
        : `── ${title()} iniciado (${formatScriptCount(handle.totalScripts)}) ──`,
    );
    await schedule(run);
    running = null;
    // Nothing is left running: whatever still waits never got its turn.
    for (const block of run.blocks.values())
      if (block.status === 'waiting' || block.status === 'running')
        setBlock(run, block.blockId, { status: 'cancelled' });
    for (const [key, script] of run.scripts)
      if (script.status === 'waiting' || script.status === 'running')
        run.scripts.set(key, { ...script, status: 'cancelled' });
    run.status = resultOf(run);
    run.finishedAt = Date.now();
    const duration = formatUptime(run.finishedAt - run.startedAt);
    const finish = (): void => {
      broadcastUpdate();
      onFinish?.(snapshotOf(run, workflowId));
    };
    if (run.status === 'cancelled') {
      pushAggregatorLog(
        aggregatorId,
        `── ${title()} cancelado (${duration}) ──`,
      );
      handle.status = 'idle';
      finish();
      return {
        ok: false,
        cancelled: true,
        error: 'cancelled',
        runId,
        aggregatorId,
      };
    }
    if (run.status === 'error') {
      const failedScripts = failedScriptCount(run);
      const reason = `scripts_failed:${failedScripts}`;
      pushAggregatorLog(
        aggregatorId,
        `── ${title()} fallido: ${formatScriptCount(failedScripts)} con error (${duration}) ──`,
        'error',
      );
      handle.status = 'error';
      finish();
      onError?.(reason, { runId, failedScripts });
      return { ok: false, error: reason, runId, aggregatorId };
    }
    handle.status = 'done';
    const warned = run.status === 'warning';
    pushAggregatorLog(
      aggregatorId,
      warned
        ? `── ${title()} completado con avisos (${duration}) ──`
        : `── ${title()} completado (${duration}) ──`,
      warned ? 'warn' : null,
    );
    finish();
    onSuccess?.({ runId, scriptCount: handle.totalScripts, warned });
    return { ok: true, runId };
  }

  /**
   * Thin guard + bookkeeping wrapper. The guard runs synchronously, so a
   * concurrent call still gets `already_running` immediately. Once past the
   * guard, the run's own promise is published via `currentRunPromise` — read
   * through `current()` — for the ENTIRE run, cleared only once it settles,
   * so a caller who awaits `current()` sees exactly the same result this
   * call resolves to.
   */
  async function track(start: () => Promise<RunResult>): Promise<RunResult> {
    const runPromise = start();
    currentRunPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      currentRunPromise = null;
    }
  }

  function run(): Promise<RunResult> {
    if (running)
      return Promise.resolve({ ok: false, error: 'already_running' });
    const pipeline = configStore.getPipeline();
    if (runnableScriptCount(pipeline) === 0)
      return Promise.resolve({ ok: true, runId: Date.now() });
    return track(() => execute(freshRun(pipeline, nextRunId()), false));
  }

  function retryFrom(blockId: string): Promise<RunResult> {
    if (running)
      return Promise.resolve({ ok: false, error: 'already_running' });
    if (!live) return Promise.resolve({ ok: false, error: 'no_run' });
    const next = planRetry(live, configStore.getPipeline(), blockId, nextRunId);
    if (typeof next === 'string')
      return Promise.resolve({ ok: false, error: next });
    return track(() => execute(next, true));
  }

  function cancel(): { ok: boolean; error?: string | undefined } {
    if (!running) return { ok: false, error: 'not_running' };
    running.cancelled = true;
    for (const pid of running.childPids) void processManager.stop(pid);
    cancelConfirm?.();
    return { ok: true };
  }

  function scriptLog(
    runId: number | 'latest',
    ref: PreStepScriptRef,
  ): LogEntry[] | null {
    if (!live || (runId !== 'latest' && runId !== live.handle.runId))
      return null;
    const key = pipelineRefKey(ref);
    if (!live.scripts.has(key)) return null;
    return [...(live.logs.get(key) ?? [])];
  }

  return {
    run,
    retryFrom,
    cancel,
    isRunning: () => running !== null,
    getSnapshot: () => (live ? snapshotOf(live, workflowId) : null),
    scriptLog,
    current: () => currentRunPromise,
  };
}
