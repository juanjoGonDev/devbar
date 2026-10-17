import {
  PIPELINE_GRID,
  extractFromBlock,
  moveBlock,
  newBlockId,
} from '../../src/pipeline-graph.js';
import type { Pipeline } from '../../src/domain-types.js';

/**
 * «Deshacer grupo»: every script of a parallel frame but the first becomes a
 * block of its own, wired like the frame was and stacked under it. The same
 * pipeline back for a block that is not a frame.
 */
export function ungroup(
  pipeline: Pipeline,
  blockId: string,
  newId: () => string = newBlockId,
): Pipeline {
  const frame = pipeline.blocks.find((block) => block.id === blockId);
  if (!frame || frame.scripts.length < 2) return pipeline;
  let next = pipeline;
  frame.scripts.slice(1).forEach((ref, index) => {
    const id = newId();
    next = extractFromBlock(next, ref, { id });
    next = moveBlock(
      next,
      id,
      frame.x,
      frame.y + (index + 1) * PIPELINE_GRID.rowGap,
    );
  });
  return next;
}

function shape(pipeline: Pipeline): string {
  return JSON.stringify({
    blocks: pipeline.blocks.map(({ id, scripts, requireAll }) => ({
      id,
      scripts,
      requireAll,
    })),
    edges: pipeline.edges,
  });
}

/** True when `next` only moves blocks of `previous` around. */
export function isLayoutOnly(previous: Pipeline, next: Pipeline): boolean {
  return shape(previous) === shape(next);
}
