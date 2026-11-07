import { formatClock, formatDuration } from '../workflows/list-model.js';
import { PIPELINE_TRIGGER, pipelineRefKey } from '../../src/pipeline-graph.js';
import type { Pipeline } from '../../src/domain-types.js';
import type {
  WorkflowNodeStatus,
  WorkflowRunState,
  WorkflowScriptRunState,
} from '../../src/ipc-contract.js';

/**
 * A workflow run as the canvas paints it: one status per block and per
 * script, the caption under a node, and the status an edge takes. Pure, so
 * the painting rules are tested without a DOM.
 */
export interface RunView {
  status: WorkflowRunState['status'];
  /** Whether the run has ended (a retry is then possible). */
  finished: boolean;
  block(blockId: string): WorkflowNodeStatus | null;
  script(refKey: string): WorkflowScriptRunState | null;
  now: number;
}

export function runView(
  state: WorkflowRunState | null,
  now: number,
): RunView | null {
  if (!state) return null;
  const blocks = new Map(state.blocks.map((b) => [b.blockId, b.status]));
  const scripts = new Map(state.scripts.map((s) => [pipelineRefKey(s), s]));
  return {
    status: state.status,
    finished: state.status !== 'running',
    block: (id) => blocks.get(id) ?? null,
    script: (key) => scripts.get(key) ?? null,
    now,
  };
}

/** `ejecutando · 0:12` while it runs, how long it took once done. */
export function nodeCaption(
  script: WorkflowScriptRunState | null,
  now: number,
): string | null {
  if (!script || script.startedAt === null) return null;
  if (script.status === 'running')
    return `ejecutando · ${formatClock(now - script.startedAt)}`;
  if (
    script.finishedAt !== null &&
    ['success', 'warning', 'error'].includes(script.status)
  )
    return formatDuration(script.finishedAt - script.startedAt);
  return null;
}

/**
 * The status an edge is painted with: the block it leads into (green into a
 * finished block, blue and flowing into a running one, red into a failed
 * one, grey into one still waiting), so the path a run took reads at a
 * glance. An edge into a block the run has no state for stays plain.
 */
export function edgeStatus(
  view: RunView | null,
  to: string,
): WorkflowNodeStatus | null {
  if (!view || to === PIPELINE_TRIGGER) return null;
  const status = view.block(to);
  return status === 'idle' ? null : status;
}

/** Every script of the run in the order the canvas lists them. */
export function runScripts(
  state: WorkflowRunState | null,
  pipeline: Pipeline,
): WorkflowScriptRunState[] {
  if (!state) return [];
  const order = pipeline.blocks.flatMap((block) =>
    block.scripts.map(pipelineRefKey),
  );
  const rank = (s: WorkflowScriptRunState): number => {
    const at = order.indexOf(pipelineRefKey(s));
    return at < 0 ? order.length : at;
  };
  return [...state.scripts].sort((a, b) => rank(a) - rank(b));
}
