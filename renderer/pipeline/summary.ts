import { formatScriptCount } from '../../src/pipeline-labels.js';
import type { Pipeline } from '../../src/domain-types.js';

/** `3 scripts`: how many pre-scripts the canvas holds, for its status pill. */
export function pipelineSummaryText(pipeline: Pipeline): string {
  return formatScriptCount(
    pipeline.blocks.reduce((n, block) => n + block.scripts.length, 0),
  );
}
