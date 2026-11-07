import type {
  Pipeline,
  PipelineBlock,
  PreStepScriptRef,
} from '../../src/domain-types.js';

/**
 * Terse builders for pipeline-graph fixtures: a block named `A` holds the
 * script `g/A` unless told otherwise, and an edge is written `'A>B'`
 * (`'trigger>A'` for the trigger).
 */

export function ref(scriptId: string, groupId = 'g'): PreStepScriptRef {
  return { groupId, scriptId };
}

export function block(
  id: string,
  scripts: readonly string[] = [id],
  x = 0,
  y = 0,
  requireAll = true,
): PipelineBlock {
  return { id, scripts: scripts.map((s) => ref(s)), x, y, requireAll };
}

export function graph(
  blocks: readonly (PipelineBlock | string)[],
  edges: readonly string[],
): Pipeline {
  return {
    blocks: blocks.map((b) => (typeof b === 'string' ? block(b) : b)),
    edges: edges.map((edge) => {
      const [from = '', to = ''] = edge.split('>');
      return { from, to };
    }),
  };
}

/** The edges as `'A>B'` strings, for compact assertions. */
export function edgeList(pipeline: Pipeline): string[] {
  return pipeline.edges.map((edge) => `${edge.from}>${edge.to}`);
}

/** Each block as `id:[scripts]`, for compact assertions. */
export function blockList(pipeline: Pipeline): string[] {
  return pipeline.blocks.map(
    (b) => `${b.id}:${b.scripts.map((s) => s.scriptId).join(',')}`,
  );
}
