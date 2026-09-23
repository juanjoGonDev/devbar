/**
 * The group/pipeline domain model, as one import surface.
 *
 * The implementation lives in `src/groups/`, split by the question each part
 * answers — `normalize` (raw snapshot → domain shape), `migrations` (schema
 * v1→v3→v4), `pipeline-ops` (pure list surgery over steps) and `validate`
 * (shape checks and cross-command invariants) — over shared raw-value
 * coercion helpers in `groups/raw.ts`. This module re-exports them so every
 * existing caller keeps one place to import from.
 */
export {
  clampConfirmSecsOrNull,
  clampMaxLogLinesOrNull,
  clampTimeoutOrNull,
  materializeEnv,
  normalizeAction,
  normalizeCommand,
  normalizeEnvEntries,
  normalizeGroup,
  normalizePreScript,
  normalizePreStep,
  normalizePreStepScriptRef,
  normalizeSchedule,
} from './groups/normalize.js';

export {
  bucketKeyFor,
  migratePreScriptPipeline,
  migrateServicesToGroups,
  planStoreMigration,
  regenerateLegacyServices,
} from './groups/migrations.js';
export {
  assignScriptToStep,
  prunePipelineRefs,
  reorderByIds,
  unassignScriptFromStep,
} from './groups/pipeline-ops.js';

export {
  enforceSingleModeAutoStart,
  validateGroupShape,
} from './groups/validate.js';
