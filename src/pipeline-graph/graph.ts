/**
 * Read-only questions about a pipeline DAG: order, reachability, cycles, the
 * scheduler's "what may start now", and the canvas auto-layout.
 *
 * Execution semantics, in one place (the runner only follows them):
 * - The trigger completes the instant the pipeline starts.
 * - A block starts once EVERY source of its incoming edges finished
 *   successfully; all of its scripts then start together, and the block
 *   finishes when every one of them has.
 * - A block with no incoming edge is disconnected and never runs. So is a
 *   block that waits on one that can never run (`runnableBlocks`).
 * - A failed block skips every descendant; independent branches carry on.
 *
 * Dependency-free on purpose: the renderer imports it as well as main.
 */
import type { Pipeline, PreStepScriptRef } from '../domain-types.js';

/** The literal an edge's `from` uses for the pipeline's start. */
export const PIPELINE_TRIGGER = 'trigger';

/**
 * Canvas grid `autoLayout` places blocks on. The trigger sits in column 0,
 * row 0 (`originX`, `originY`); column N is `originX + N * columnGap`.
 */
export const PIPELINE_GRID = {
  originX: 40,
  originY: 40,
  columnGap: 280,
  rowGap: 120,
} as const;

/** Where one block stands while the pipeline runs. */
export type BlockRunStatus =
  'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** Why `canConnect` refuses an edge. */
export type ConnectRejection =
  'self' | 'into_trigger' | 'unknown_block' | 'duplicate' | 'cycle';

/** One key per script, for sets: UUIDs never contain `::`. */
export function pipelineRefKey(ref: PreStepScriptRef): string {
  return `${ref.groupId}::${ref.scriptId}`;
}

export function emptyPipeline(): Pipeline {
  return { blocks: [], edges: [] };
}

/** The block holding `ref`, or null when the script is not placed. */
export function blockOf(
  pipeline: Pipeline,
  ref: PreStepScriptRef,
): Pipeline['blocks'][number] | null {
  const key = pipelineRefKey(ref);
  return (
    pipeline.blocks.find((block) =>
      block.scripts.some((script) => pipelineRefKey(script) === key),
    ) ?? null
  );
}

/** `pipelineRefKey` of every placed script. */
export function placedRefKeys(pipeline: Pipeline): Set<string> {
  return new Set(
    pipeline.blocks.flatMap((block) => block.scripts.map(pipelineRefKey)),
  );
}

function sourcesOf(pipeline: Pipeline, blockId: string): string[] {
  return pipeline.edges
    .filter((edge) => edge.to === blockId)
    .map((edge) => edge.from);
}

function targetsOf(pipeline: Pipeline, blockId: string): string[] {
  return pipeline.edges
    .filter((edge) => edge.from === blockId)
    .map((edge) => edge.to);
}

/**
 * Every block id, each after all of its sources (Kahn's algorithm). Ties go
 * to the order the blocks are stored in, so the result is stable. A block
 * caught in a cycle (which normalization never lets through) is appended at
 * the end rather than dropped.
 */
export function topologicalOrder(pipeline: Pipeline): string[] {
  const ids = pipeline.blocks.map((block) => block.id);
  const known = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of pipeline.edges)
    if (known.has(edge.to) && known.has(edge.from))
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const order: string[] = [];
  const placed = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of ids) {
      if (placed.has(id) || (indegree.get(id) ?? 0) > 0) continue;
      placed.add(id);
      order.push(id);
      progressed = true;
      for (const target of targetsOf(pipeline, id))
        indegree.set(target, (indegree.get(target) ?? 0) - 1);
      break;
    }
  }
  for (const id of ids) if (!placed.has(id)) order.push(id);
  return order;
}

/** Blocks with no incoming edge: they never run. */
export function disconnectedBlocks(pipeline: Pipeline): string[] {
  const targets = new Set(pipeline.edges.map((edge) => edge.to));
  return pipeline.blocks
    .map((block) => block.id)
    .filter((id) => !targets.has(id));
}

/**
 * The blocks a run will actually try, in topological order: those with at
 * least one incoming edge and every source either the trigger or itself
 * runnable. A block that waits on a disconnected one would wait forever, so
 * it is left out too.
 */
export function runnableBlocks(pipeline: Pipeline): string[] {
  const runnable = new Set<string>();
  for (const id of topologicalOrder(pipeline)) {
    const sources = sourcesOf(pipeline, id);
    if (
      sources.length > 0 &&
      sources.every(
        (source) => source === PIPELINE_TRIGGER || runnable.has(source),
      )
    )
      runnable.add(id);
  }
  return [...runnable];
}

/** How many scripts a run will try: the progress bar's denominator. */
export function runnableScriptCount(pipeline: Pipeline): number {
  const runnable = new Set(runnableBlocks(pipeline));
  return pipeline.blocks
    .filter((block) => runnable.has(block.id))
    .reduce((sum, block) => sum + block.scripts.length, 0);
}

/**
 * The runnable, still `pending` blocks whose every source is the trigger or
 * `done` — what the runner starts next. A block absent from `statuses` is
 * pending. Returned in stored block order.
 */
export function readyBlocks(
  pipeline: Pipeline,
  statuses: ReadonlyMap<string, BlockRunStatus>,
): string[] {
  const runnable = new Set(runnableBlocks(pipeline));
  const statusOf = (id: string): BlockRunStatus =>
    statuses.get(id) ?? 'pending';
  return pipeline.blocks
    .map((block) => block.id)
    .filter(
      (id) =>
        runnable.has(id) &&
        statusOf(id) === 'pending' &&
        sourcesOf(pipeline, id).every(
          (source) =>
            source === PIPELINE_TRIGGER || statusOf(source) === 'done',
        ),
    );
}

/** Every block downstream of `blockId` (not including it). */
export function descendants(pipeline: Pipeline, blockId: string): string[] {
  const seen = new Set<string>();
  const queue = [blockId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const target of targetsOf(pipeline, current)) {
      if (seen.has(target) || target === blockId) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return pipeline.blocks.map((b) => b.id).filter((id) => seen.has(id));
}

/** The still-pending descendants a failure of `failedId` has to skip. */
export function blocksToSkip(
  pipeline: Pipeline,
  failedId: string,
  statuses: ReadonlyMap<string, BlockRunStatus>,
): string[] {
  return descendants(pipeline, failedId).filter(
    (id) => (statuses.get(id) ?? 'pending') === 'pending',
  );
}

/** Whether adding `from → to` would close a cycle (a self edge does). */
export function wouldCreateCycle(
  pipeline: Pipeline,
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  return descendants(pipeline, to).includes(from);
}

/** Why `from → to` cannot be added, or null when it can. */
export function canConnect(
  pipeline: Pipeline,
  from: string,
  to: string,
): ConnectRejection | null {
  if (from === to) return 'self';
  if (to === PIPELINE_TRIGGER) return 'into_trigger';
  const ids = new Set(pipeline.blocks.map((block) => block.id));
  if (!ids.has(to) || (from !== PIPELINE_TRIGGER && !ids.has(from)))
    return 'unknown_block';
  if (pipeline.edges.some((edge) => edge.from === from && edge.to === to))
    return 'duplicate';
  if (wouldCreateCycle(pipeline, from, to)) return 'cycle';
  return null;
}

/**
 * Layered left-to-right placement: a block's column is the longest path to it
 * from the trigger (a block with no source counts as hanging off the
 * trigger, column 1); inside a column, blocks stack in topological order.
 * Only `x`/`y` change.
 */
export function autoLayout(pipeline: Pipeline): Pipeline {
  const column = new Map<string, number>();
  for (const id of topologicalOrder(pipeline)) {
    const depths = sourcesOf(pipeline, id).map((source) =>
      source === PIPELINE_TRIGGER ? 0 : (column.get(source) ?? 0),
    );
    column.set(id, Math.max(0, ...depths) + 1);
  }
  const rows = new Map<number, number>();
  const position = new Map<string, { x: number; y: number }>();
  for (const id of topologicalOrder(pipeline)) {
    const col = column.get(id) ?? 1;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    position.set(id, {
      x: PIPELINE_GRID.originX + col * PIPELINE_GRID.columnGap,
      y: PIPELINE_GRID.originY + row * PIPELINE_GRID.rowGap,
    });
  }
  return {
    blocks: pipeline.blocks.map((block) => ({
      ...block,
      ...(position.get(block.id) ?? { x: block.x, y: block.y }),
    })),
    edges: pipeline.edges,
  };
}
