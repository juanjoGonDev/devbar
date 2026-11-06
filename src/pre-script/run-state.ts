/**
 * One workflow run's state, and the pure steps over it: a fresh run of a
 * graph, the statuses a settled script or block reads as, the snapshot sent
 * to the renderers, how the run ended, and the retry plan that carries the
 * successful blocks of the last run over. Split out of
 * src/pre-script-runner.ts, which keeps the scheduling and the processes.
 */
import type {
  LogEntry,
  Pipeline,
  PreStepScriptRef,
  WorkflowRunResult,
} from '../domain-types.js';
import type {
  WorkflowBlockRunState,
  WorkflowNodeStatus,
  WorkflowRunState,
  WorkflowScriptRunState,
} from '../ipc-contract.js';
import { makeAggregatorId } from '../compound-id.js';
import {
  PIPELINE_TRIGGER,
  descendants,
  pipelineRefKey,
  runnableBlocks,
  runnableScriptCount,
  type BlockRunStatus,
} from '../pipeline-graph.js';
import type { OneResult, RunHandle } from './run-one.js';

/** One run's whole mutable state: scheduling and what it reports. */
export interface LiveRun {
  pipeline: Pipeline;
  handle: RunHandle;
  /** The scheduler's view (src/pipeline-graph.ts semantics). */
  internal: Map<string, BlockRunStatus>;
  blocks: Map<string, WorkflowBlockRunState>;
  scripts: Map<string, WorkflowScriptRunState>;
  logs: Map<string, LogEntry[]>;
  status: WorkflowRunState['status'];
  startedAt: number;
  finishedAt: number | null;
  /** `Bloque 2/5` — how the aggregator log names a block. */
  labelOf: (blockId: string) => string;
}

const SETTLED_OK: readonly WorkflowNodeStatus[] = ['success', 'warning'];

/** How much of one script's output a run keeps for `scriptLog`. */
const SCRIPT_LOG_LIMIT = 2000;

/** Keeps one line of a script's output for the run, dropping the oldest. */
export function appendScriptLog(
  run: LiveRun,
  key: string,
  entry: LogEntry,
): void {
  const lines = run.logs.get(key) ?? [];
  lines.push(entry);
  if (lines.length > SCRIPT_LOG_LIMIT) lines.shift();
  run.logs.set(key, lines);
}

export function snapshotOf(run: LiveRun, workflowId: string): WorkflowRunState {
  return {
    workflowId,
    runId: run.handle.runId,
    aggregatorId: run.handle.aggregatorId,
    status: run.status,
    blocks: [...run.blocks.values()].map((b) => ({ ...b })),
    scripts: [...run.scripts.values()].map((s) => ({ ...s })),
    doneScripts: run.handle.doneScripts,
    totalScripts: run.handle.totalScripts,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export function setScript(
  run: LiveRun,
  ref: PreStepScriptRef,
  patch: Partial<WorkflowScriptRunState>,
): void {
  const key = pipelineRefKey(ref);
  const current = run.scripts.get(key);
  if (current) run.scripts.set(key, { ...current, ...patch });
}
export function setBlock(
  run: LiveRun,
  blockId: string,
  patch: Partial<WorkflowBlockRunState>,
): void {
  const current = run.blocks.get(blockId);
  if (current) run.blocks.set(blockId, { ...current, ...patch });
}

/** How one settled script reads, given why it settled. */
export function scriptStatusOf(
  result: OneResult,
  aborted: boolean,
  cancelled: boolean,
): WorkflowNodeStatus {
  if (result.ok) return result.warned ? 'warning' : 'success';
  if (aborted || cancelled || result.cancelled) return 'cancelled';
  return 'error';
}

/** A fresh run of `pipeline`: every runnable block waiting. */
export function freshRun(pipeline: Pipeline, runId: number): LiveRun {
  const order = runnableBlocks(pipeline);
  const runnable = new Set(order);
  const blocks = new Map<string, WorkflowBlockRunState>();
  const scripts = new Map<string, WorkflowScriptRunState>();
  for (const block of pipeline.blocks) {
    const status: WorkflowNodeStatus = runnable.has(block.id)
      ? 'waiting'
      : 'idle';
    blocks.set(block.id, {
      blockId: block.id,
      status,
      startedAt: null,
      finishedAt: null,
    });
    for (const ref of block.scripts)
      scripts.set(pipelineRefKey(ref), {
        ...ref,
        blockId: block.id,
        status,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
      });
  }
  return {
    pipeline,
    handle: {
      runId,
      aggregatorId: makeAggregatorId(runId),
      cancelled: false,
      childPids: new Set(),
      doneScripts: 0,
      totalScripts: runnableScriptCount(pipeline),
      status: 'running',
      _timedOutScripts: new Set(),
    },
    // A block the run never reaches is never pending: `readyBlocks` only
    // looks at runnable ones anyway.
    internal: new Map(),
    blocks,
    scripts,
    logs: new Map(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    // `Bloque 2/5`: the aggregator narrates the workflow, never one script
    // (that goes to the script's own buffer), so blocks go by their place
    // in the run's topological order.
    labelOf: (id) => `Bloque ${order.indexOf(id) + 1}/${order.length}`,
  };
}

/** How the whole run ended, from the final statuses. */
export function resultOf(run: LiveRun): WorkflowRunResult {
  if (run.handle.cancelled) return 'cancelled';
  const blockStatuses = [...run.blocks.values()].map((b) => b.status);
  if (blockStatuses.includes('error')) return 'error';
  if (blockStatuses.includes('cancelled')) return 'cancelled';
  const warned =
    blockStatuses.includes('warning') ||
    [...run.scripts.values()].some(
      (s) => s.status === 'warning' || s.status === 'error',
    );
  return warned ? 'warning' : 'success';
}

/** Scripts that failed inside a block that failed because of them. */
export function failedScriptCount(run: LiveRun): number {
  const failedBlocks = new Set(
    [...run.blocks.values()]
      .filter((b) => b.status === 'error')
      .map((b) => b.blockId),
  );
  return [...run.scripts.values()].filter(
    (s) => s.status === 'error' && failedBlocks.has(s.blockId),
  ).length;
}

/**
 * The next run of a retry from `blockId`: that block and every descendant
 * that did not succeed last time run again; every other block keeps its last
 * status (and logs) and is never started. A reason string when it cannot be
 * retried: an unknown block, or one whose sources did not all succeed.
 */
export function planRetry(
  last: LiveRun,
  pipeline: Pipeline,
  blockId: string,
  nextRunId: () => number,
): LiveRun | 'unknown_block' | 'not_ready' {
  if (!pipeline.blocks.some((b) => b.id === blockId)) return 'unknown_block';
  const settledOk = (id: string): boolean =>
    SETTLED_OK.includes(last.blocks.get(id)?.status ?? 'idle');
  const ready = pipeline.edges
    .filter((edge) => edge.to === blockId)
    .every((edge) => edge.from === PIPELINE_TRIGGER || settledOk(edge.from));
  if (!ready) return 'not_ready';
  const rerun = new Set([
    blockId,
    ...descendants(pipeline, blockId).filter((id) => !settledOk(id)),
  ]);
  const next = freshRun(pipeline, nextRunId());
  const runnable = new Set(runnableBlocks(pipeline));
  for (const block of pipeline.blocks) {
    if (rerun.has(block.id) || !runnable.has(block.id)) continue;
    // Kept as it was: the scheduler must never start it again.
    const kept = last.blocks.get(block.id);
    next.internal.set(block.id, settledOk(block.id) ? 'done' : 'skipped');
    if (kept) next.blocks.set(block.id, { ...kept });
    for (const ref of block.scripts) {
      const key = pipelineRefKey(ref);
      const keptScript = last.scripts.get(key);
      if (keptScript) next.scripts.set(key, { ...keptScript });
      const logs = last.logs.get(key);
      if (logs) next.logs.set(key, logs);
      next.handle.doneScripts += 1;
    }
  }
  return next;
}
