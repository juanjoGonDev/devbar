/**
 * The canvas's editing gestures, as pure functions over a `Pipeline`. Each
 * returns the next pipeline — or the very SAME object when the gesture is a
 * no-op, so the caller can skip the write. None of them breaks an invariant
 * normalization enforces: a script stays in at most one block, an emptied
 * block disappears with its edges, and an edge that would close a cycle is
 * refused.
 */
import type {
  Pipeline,
  PipelineBlock,
  PreStepScriptRef,
} from '../domain-types.js';
import {
  PIPELINE_GRID,
  PIPELINE_TRIGGER,
  blockOf,
  canConnect,
  pipelineRefKey,
} from './graph.js';

/** A fresh block id. `crypto.randomUUID` exists in main and the renderer. */
export function newBlockId(): string {
  return globalThis.crypto.randomUUID();
}

/** Removes `blockId` and every edge touching it. */
export function removeBlock(pipeline: Pipeline, blockId: string): Pipeline {
  if (!pipeline.blocks.some((block) => block.id === blockId)) return pipeline;
  return {
    blocks: pipeline.blocks.filter((block) => block.id !== blockId),
    edges: pipeline.edges.filter(
      (edge) => edge.from !== blockId && edge.to !== blockId,
    ),
  };
}

/** Takes `ref` out of its block; an emptied block goes with its edges. */
export function removeScript(
  pipeline: Pipeline,
  ref: PreStepScriptRef,
): Pipeline {
  const holder = blockOf(pipeline, ref);
  if (!holder) return pipeline;
  if (holder.scripts.length === 1) return removeBlock(pipeline, holder.id);
  const key = pipelineRefKey(ref);
  return {
    blocks: pipeline.blocks.map((block) =>
      block.id === holder.id
        ? {
            ...block,
            scripts: block.scripts.filter((s) => pipelineRefKey(s) !== key),
          }
        : block,
    ),
    edges: pipeline.edges,
  };
}

export interface AddBlockOptions {
  /** Defaults to a fresh UUID. */
  id?: string;
  /** A block id or `'trigger'`: the new block is wired to wait for it. */
  from?: string;
  /** Defaults to one column right of `from` (or of the trigger). */
  x?: number;
  y?: number;
}

/**
 * A new single-script block. A script already placed elsewhere is moved, not
 * duplicated. An unknown `from` is ignored (the block is left disconnected).
 */
export function addBlock(
  pipeline: Pipeline,
  ref: PreStepScriptRef,
  options: AddBlockOptions = {},
): Pipeline {
  const base = removeScript(pipeline, ref);
  const source =
    options.from === undefined
      ? undefined
      : options.from === PIPELINE_TRIGGER
        ? { x: PIPELINE_GRID.originX, y: PIPELINE_GRID.originY }
        : base.blocks.find((block) => block.id === options.from);
  const block: PipelineBlock = {
    id: options.id ?? newBlockId(),
    scripts: [ref],
    x:
      options.x ??
      (source?.x ?? PIPELINE_GRID.originX) + PIPELINE_GRID.columnGap,
    y: options.y ?? source?.y ?? PIPELINE_GRID.originY,
    requireAll: true,
  };
  const added = { blocks: [...base.blocks, block], edges: base.edges };
  return source && options.from !== undefined
    ? connect(added, options.from, block.id)
    : added;
}

/** Drops `ref` into `blockId`, turning it into (or growing) a parallel frame. */
export function joinIntoBlock(
  pipeline: Pipeline,
  ref: PreStepScriptRef,
  blockId: string,
): Pipeline {
  const target = pipeline.blocks.find((block) => block.id === blockId);
  if (!target) return pipeline;
  if (blockOf(pipeline, ref)?.id === blockId) return pipeline;
  const base = removeScript(pipeline, ref);
  return {
    blocks: base.blocks.map((block) =>
      block.id === blockId
        ? { ...block, scripts: [...block.scripts, ref] }
        : block,
    ),
    edges: base.edges,
  };
}

/**
 * Takes `ref` out of its parallel frame into a block of its own, right below
 * the frame and wired exactly like it — so it still runs at the same moment.
 * A script that already has its own block stays put.
 */
export function extractFromBlock(
  pipeline: Pipeline,
  ref: PreStepScriptRef,
  options: { id?: string } = {},
): Pipeline {
  const holder = blockOf(pipeline, ref);
  if (!holder || holder.scripts.length < 2) return pipeline;
  const id = options.id ?? newBlockId();
  const base = removeScript(pipeline, ref);
  const incoming = pipeline.edges
    .filter((edge) => edge.to === holder.id)
    .map((edge) => ({ from: edge.from, to: id }));
  const outgoing = pipeline.edges
    .filter((edge) => edge.from === holder.id)
    .map((edge) => ({ from: id, to: edge.to }));
  return {
    blocks: [
      ...base.blocks,
      {
        id,
        scripts: [ref],
        x: holder.x,
        y: holder.y + PIPELINE_GRID.rowGap,
        requireAll: true,
      },
    ],
    edges: [...base.edges, ...incoming, ...outgoing],
  };
}

/** Adds `from → to` unless `canConnect` refuses it. */
export function connect(
  pipeline: Pipeline,
  from: string,
  to: string,
): Pipeline {
  if (canConnect(pipeline, from, to) !== null) return pipeline;
  return { blocks: pipeline.blocks, edges: [...pipeline.edges, { from, to }] };
}

export function disconnect(
  pipeline: Pipeline,
  from: string,
  to: string,
): Pipeline {
  const edges = pipeline.edges.filter(
    (edge) => !(edge.from === from && edge.to === to),
  );
  return edges.length === pipeline.edges.length
    ? pipeline
    : { blocks: pipeline.blocks, edges };
}

/** Turns a block's «Todos OK» on or off. */
export function setRequireAll(
  pipeline: Pipeline,
  blockId: string,
  requireAll: boolean,
): Pipeline {
  const target = pipeline.blocks.find((block) => block.id === blockId);
  if (!target || target.requireAll === requireAll) return pipeline;
  return {
    blocks: pipeline.blocks.map((block) =>
      block.id === blockId ? { ...block, requireAll } : block,
    ),
    edges: pipeline.edges,
  };
}

export function moveBlock(
  pipeline: Pipeline,
  blockId: string,
  x: number,
  y: number,
): Pipeline {
  const target = pipeline.blocks.find((block) => block.id === blockId);
  if (!target || (target.x === x && target.y === y)) return pipeline;
  return {
    blocks: pipeline.blocks.map((block) =>
      block.id === blockId ? { ...block, x, y } : block,
    ),
    edges: pipeline.edges,
  };
}
