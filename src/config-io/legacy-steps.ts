/**
 * The importer's legacy side: a v3 payload's per-group steps, and the ordered
 * `preSteps` of any export from before the graph, validated as strictly as
 * ever and turned into one pipeline graph (`fromLegacySteps`). Split out of
 * src/config-io.ts so the importer itself reads as the current shape.
 */
import type { Group, Pipeline, PreStep } from '../domain-types.js';
import { migratePreScriptPipeline, normalizePreStep } from '../groups-model.js';
import { fromLegacySteps } from '../pipeline-graph.js';

const MIN_SUPPORTED_VERSION = 3;
type UnknownRecord = Record<string, unknown>;
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

/**
 * Hoists a v3 payload's nested per-group script definitions into the global
 * pipeline shape. A v4 payload passes straight through.
 *
 * Extracted from `validateImportedConfig` to keep that function under the
 * repo's complexity ceiling; it is also the only part of the importer that
 * needs to reason about two schema versions at once.
 */
export function applyV3Migration(value: {
  version?: unknown;
  groups: unknown[];
  preSteps?: unknown;
  globalSettings?: unknown;
}): { groups: unknown[]; steps: unknown; autoRun: boolean | undefined } {
  if (value.version !== MIN_SUPPORTED_VERSION)
    return { groups: value.groups, steps: value.preSteps, autoRun: undefined };

  const migrated = migratePreScriptPipeline({
    groups: value.groups,
    preSteps: value.preSteps,
    globalSettings: value.globalSettings,
  });
  const groups = value.groups.map((rawGroup, index) => {
    const migratedGroup = migrated.groups[index];
    return {
      ...record(rawGroup),
      // The migration mints an id for an id-less group and points its refs at
      // it; re-normalizing the raw group would mint a different one and the
      // cross-reference check would then reject the whole import.
      ...(migratedGroup ? { id: migratedGroup.id } : {}),
      preScripts: migratedGroup?.preScripts ?? [],
    };
  });
  // `migrated.preSteps` (existing + hoisted, both already normalized) is
  // right for the LIVE STORE, which has no separate validation pass. The
  // importer DOES have one, right below — so using `migrated.preSteps` here
  // would let an invalid `mode`, an invalid `scripts` value, or a malformed
  // ref inside the payload's OWN top-level `preSteps` get silently defaulted
  // into something valid before that validation ever runs. Only
  // `migrated.hoistedSteps` (freshly built by the migration itself, so
  // always well-formed) is safe to trust outright; the payload's own
  // top-level steps are passed through EXACTLY as authored so they still
  // face the same strict checks a v4 payload's would — the same
  // v3-leniency-stays-scoped principle already applied to `preScripts` above.
  const rawTopLevelSteps: unknown = value.preSteps;
  const steps: unknown = isUnknownArray(rawTopLevelSteps)
    ? [...rawTopLevelSteps, ...migrated.hoistedSteps]
    : rawTopLevelSteps === undefined
      ? migrated.hoistedSteps
      : rawTopLevelSteps;
  return {
    groups,
    steps,
    // Only when legacy data was actually hoisted. A store mislabelled v3 that
    // already holds v4 data has zero contributors, and the AND-fold would
    // silently turn OFF an auto-run the payload had enabled.
    // Gate on real contributors, NOT on `changed`: an empty legacy
    // `preSteps: []` flips `changed` while contributing nothing, and the
    // AND-fold would then turn OFF an auto-run the payload had enabled.
    // Same guard `planStoreMigration` uses on the live-store path.
    autoRun:
      migrated.preScriptsAutoRunContributors > 0
        ? migrated.preScriptsAutoRun
        : undefined,
  };
}

/**
 * Validates the global pipeline against the rest of the payload.
 *
 * This importer is the only place that sees the WHOLE payload at once, so it
 * is the only place three invariants the editor maintains by construction can
 * be checked: refs resolve, step ids are unique, and a script is placed in at
 * most one step. Hand-edited or third-party JSON honours none of them.
 *
 * Extracted from `validateImportedConfig` to keep it under the repo's
 * complexity ceiling.
 */
function validatePipelineSteps(
  rawSteps: readonly unknown[],
  groupIds: ReadonlySet<string>,
  scriptIdsByGroup: ReadonlyMap<string, Set<string>>,
): { ok: true; steps: PreStep[] } | { ok: false; error: string } {
  const steps: PreStep[] = [];
  const usedStepIds = new Set<string>();
  // A ref in two steps shares one process id, so the later placement never
  // really runs — and it still delays that group's autoStart release to the
  // later step. `assignScriptToStep` enforces this in the editor.
  const placedRefs = new Set<string>();

  for (let stepIndex = 0; stepIndex < rawSteps.length; stepIndex++) {
    const rawStep = record(rawSteps[stepIndex]);
    if (
      rawStep.mode !== undefined &&
      rawStep.mode !== 'parallel' &&
      rawStep.mode !== 'serial'
    )
      return { ok: false, error: `Paso #${stepIndex} con mode inválido` };
    if (rawStep.scripts !== undefined && !isUnknownArray(rawStep.scripts))
      return { ok: false, error: `Paso #${stepIndex} scripts debe ser array` };

    const rawRefs = isUnknownArray(rawStep.scripts) ? rawStep.scripts : [];
    for (const candidate of rawRefs) {
      const ref = record(candidate);
      const groupId = typeof ref.groupId === 'string' ? ref.groupId : '';
      const scriptId = typeof ref.scriptId === 'string' ? ref.scriptId : '';
      const resolves =
        groupId !== '' &&
        scriptId !== '' &&
        groupIds.has(groupId) &&
        Boolean(scriptIdsByGroup.get(groupId)?.has(scriptId));
      if (!resolves)
        return {
          ok: false,
          error: `Paso #${stepIndex} referencia un grupo o script inexistente`,
        };
    }

    // Checked on the NORMALIZED step: a missing id is minted as a fresh uuid
    // (never a false duplicate), while a provided one is kept as-is.
    const step = normalizePreStep(rawStep);
    if (usedStepIds.has(step.id))
      return {
        ok: false,
        error: `Paso #${stepIndex} repite el id de otro paso`,
      };
    usedStepIds.add(step.id);

    for (const ref of step.scripts) {
      const key = `${ref.groupId}/${ref.scriptId}`;
      if (placedRefs.has(key))
        return {
          ok: false,
          error: `Paso #${stepIndex} coloca un script que ya está en otro paso`,
        };
      placedRefs.add(key);
    }
    steps.push(step);
  }
  return { ok: true, steps };
}

/** The legacy ordered steps, validated (`validatePipelineSteps`) and chained. */
export function validateLegacySteps(
  rawSteps: readonly unknown[],
  groups: readonly Group[],
  scriptIdsByGroup: ReadonlyMap<string, Set<string>>,
): { ok: true; pipeline: Pipeline } | { ok: false; error: string } {
  const steps = validatePipelineSteps(
    rawSteps,
    new Set(groups.map((group) => group.id)),
    scriptIdsByGroup,
  );
  return steps.ok
    ? { ok: true, pipeline: fromLegacySteps(steps.steps) }
    : steps;
}
