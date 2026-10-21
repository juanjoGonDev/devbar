/**
 * The pre-script pipeline as a DAG — one import surface for main AND the
 * renderer (it is dependency-free, so tsc emits it into the renderer build).
 *
 * - `pipeline-graph/graph.ts` — read-only questions and the execution
 *   semantics: order, runnable/disconnected blocks, what may start now,
 *   cycles, auto-layout.
 * - `pipeline-graph/edit.ts` — the canvas's editing gestures.
 * - `pipeline-graph/normalize.ts` — lenient store reads, strict validation,
 *   the legacy-steps migration and ref pruning.
 */
export {
  PIPELINE_GRID,
  PIPELINE_TRIGGER,
  autoLayout,
  blockOf,
  blocksToSkip,
  canConnect,
  descendants,
  disconnectedBlocks,
  emptyPipeline,
  pipelineRefKey,
  placedRefKeys,
  readyBlocks,
  runnableBlocks,
  runnableScriptCount,
  topologicalOrder,
  wouldCreateCycle,
  type BlockRunStatus,
  type ConnectRejection,
} from './pipeline-graph/graph.js';
export {
  addBlock,
  connect,
  disconnect,
  extractFromBlock,
  joinIntoBlock,
  moveBlock,
  newBlockId,
  removeBlock,
  removeScript,
  setRequireAll,
  type AddBlockOptions,
} from './pipeline-graph/edit.js';
export {
  fromLegacySteps,
  normalizePipeline,
  pruneRefs,
  validatePipeline,
  type PipelineValidation,
} from './pipeline-graph/normalize.js';
