import type { GlobalSettings, Group, PreStep } from './domain-types.js';
import {
  normalizeGroup,
  normalizePreStep,
  validateGroupShape,
  migratePreScriptPipeline,
} from './groups-model.js';

export const EXPORT_SCHEMA_VERSION = 4;
/** A v3 export/store file (nested per-group `preSteps`) still imports. */
const MIN_SUPPORTED_VERSION = 3;
type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}
function label(group: UnknownRecord, index: number): string {
  return typeof group.name === 'string' && group.name
    ? group.name
    : `#${index}`;
}
function invalidEnv(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return true;
  if (Array.isArray(value)) return value.some((entry) => !isRecord(entry));
  return !isRecord(value);
}

export interface SerializedConfig {
  exportedAt: string;
  appVersion: string | null;
  version: number;
  groups: Group[];
  preSteps: PreStep[];
  globalSettings: Partial<GlobalSettings>;
}
export interface ImportPayload {
  version: number;
  groups: Group[];
  preSteps: PreStep[];
  globalSettings: Partial<GlobalSettings>;
}
export type ImportValidation =
  { ok: true; payload: ImportPayload } | { ok: false; error: string };

export function serializeConfig(
  rawStore:
    | {
        version?: number;
        groups?: Group[];
        preSteps?: PreStep[];
        globalSettings?: Partial<GlobalSettings>;
      }
    | null
    | undefined,
  appVersion: string | null = null,
): SerializedConfig {
  const raw = rawStore ?? {};
  return {
    exportedAt: new Date().toISOString(),
    appVersion: appVersion || null,
    version:
      typeof raw.version === 'number' ? raw.version : EXPORT_SCHEMA_VERSION,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    preSteps: Array.isArray(raw.preSteps) ? raw.preSteps : [],
    globalSettings: raw.globalSettings ?? {},
  };
}

/**
 * Hoists a v3 payload's nested per-group script definitions into the global
 * pipeline shape. A v4 payload passes straight through.
 *
 * Extracted from `validateImportedConfig` to keep that function under the
 * repo's complexity ceiling; it is also the only part of the importer that
 * needs to reason about two schema versions at once.
 */
function applyV3Migration(value: {
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
    autoRun: migrated.changed ? migrated.preScriptsAutoRun : undefined,
  };
}

export function validateImportedConfig(value: unknown): ImportValidation {
  if (!isRecord(value))
    return { ok: false, error: 'Root must be a JSON object' };
  if (
    value.version !== EXPORT_SCHEMA_VERSION &&
    value.version !== MIN_SUPPORTED_VERSION
  )
    return {
      ok: false,
      error: `Versión de schema incompatible (admitidas ${MIN_SUPPORTED_VERSION} y ${EXPORT_SCHEMA_VERSION}, recibida ${String(value.version)})`,
    };
  if (!isUnknownArray(value.groups))
    return { ok: false, error: 'groups debe ser un array' };

  // A v3 export nests script DEFINITIONS inside per-group steps; reuse the
  // SAME concatenate-and-hoist migration the live store uses (D4) so the two
  // can never drift. Only the hoisted `preScripts` is overlaid onto each
  // ORIGINAL raw group below — migratePreScriptPipeline fully normalizes
  // every field as a side effect of hoisting, and using its groups wholesale
  // would silently let a v3 payload's malformed command/action (e.g. a
  // missing name) import as "Unnamed" instead of being rejected, same as the
  // live store already defaults it, but MUCH more broadly than intended:
  // this keeps that one accepted trade-off scoped to preScripts alone. Only
  // this importer sees the WHOLE payload, so the pipeline cross-reference
  // validation below still runs natively either way.
  const {
    groups: rawGroups,
    steps: rawSteps,
    autoRun: migratedAutoRun,
  } = applyV3Migration({
    version: value.version,
    groups: value.groups,
    preSteps: value.preSteps,
    globalSettings: value.globalSettings,
  });

  if (rawSteps !== undefined && !isUnknownArray(rawSteps))
    return { ok: false, error: 'preSteps debe ser un array' };
  const preStepsInput = isUnknownArray(rawSteps) ? rawSteps : [];

  const cleanGroups: Group[] = [];
  const scriptIdsByGroup = new Map<string, Set<string>>();
  for (let index = 0; index < rawGroups.length; index++) {
    const rawGroup = record(rawGroups[index]);
    const groupLabel = label(rawGroup, index);
    const commands = isUnknownArray(rawGroup.commands) ? rawGroup.commands : [];
    for (const candidate of commands) {
      const command = record(candidate);
      if (typeof command.command !== 'string' || !command.command.trim())
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene un comando sin campo command`,
        };
      if (typeof command.name !== 'string' || !command.name.trim())
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene un comando sin name`,
        };
      if (invalidEnv(command.env))
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene un comando con env inválido (debe ser objeto o array)`,
        };
    }
    const actions = isUnknownArray(rawGroup.actions) ? rawGroup.actions : [];
    for (const candidate of actions) {
      const action = record(candidate);
      if (typeof action.name !== 'string' || !action.name.trim())
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene una acción sin name`,
        };
      if (invalidEnv(action.env))
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene una acción con env inválido (debe ser objeto o array)`,
        };
    }
    const groupEnv = rawGroup.env;
    if (
      groupEnv !== undefined &&
      groupEnv !== null &&
      (!isUnknownArray(groupEnv) ||
        groupEnv.some((entry: unknown) => !isRecord(entry)))
    ) {
      return {
        ok: false,
        error: `Grupo "${groupLabel}" tiene un env de grupo inválido (debe ser array)`,
      };
    }
    const preScripts = isUnknownArray(rawGroup.preScripts)
      ? rawGroup.preScripts
      : [];
    for (const candidate of preScripts) {
      const script = record(candidate);
      if (typeof script.command !== 'string' || !script.command.trim())
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene un pre-script sin command`,
        };
      if (typeof script.name !== 'string' || !script.name.trim())
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene un pre-script sin name`,
        };
      if (invalidEnv(script.env))
        return {
          ok: false,
          error: `Grupo "${groupLabel}" tiene un pre-script con env inválido`,
        };
    }
    const group = normalizeGroup(rawGroup);
    const validation = validateGroupShape(group);
    if (!validation.valid)
      return {
        ok: false,
        error: `Grupo #${index} "${group.name}": ${validation.errors.join(', ')}`,
      };
    cleanGroups.push(group);
    scriptIdsByGroup.set(
      group.id,
      new Set(group.preScripts.map((script) => script.id)),
    );
  }

  // Only this importer sees the whole payload at once, so this is the one
  // place a pipeline ref's cross-reference (does {groupId,scriptId} resolve
  // to a real script in this SAME payload?) can be validated.
  const groupIds = new Set(cleanGroups.map((group) => group.id));
  const cleanSteps: PreStep[] = [];
  for (let stepIndex = 0; stepIndex < preStepsInput.length; stepIndex++) {
    const rawStep = record(preStepsInput[stepIndex]);
    if (
      rawStep.mode !== undefined &&
      rawStep.mode !== 'parallel' &&
      rawStep.mode !== 'serial'
    )
      return { ok: false, error: `Paso #${stepIndex} con mode inválido` };
    if (rawStep.scripts !== undefined && !isUnknownArray(rawStep.scripts))
      return {
        ok: false,
        error: `Paso #${stepIndex} scripts debe ser array`,
      };
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
    cleanSteps.push(normalizePreStep(rawStep));
  }

  const settings = record(value.globalSettings);
  const cleanGlobalSettings: Partial<GlobalSettings> = {
    autostart: Boolean(settings.autostart),
    silenceWarnings: Boolean(settings.silenceWarnings),
    silenceErrors: Boolean(settings.silenceErrors),
    preScriptsAutoRun:
      migratedAutoRun !== undefined
        ? migratedAutoRun
        : Boolean(settings.preScriptsAutoRun),
  };
  return {
    ok: true,
    payload: {
      version: EXPORT_SCHEMA_VERSION,
      groups: cleanGroups,
      preSteps: cleanSteps,
      globalSettings: cleanGlobalSettings,
    },
  };
}

export function summarizeImport(value: unknown): {
  groupsCount: number;
  commandsCount: number;
  actionsCount: number;
  preStepsCount: number;
  preScriptsCount: number;
  hasGlobalSettings: boolean;
} {
  const payload = record(value);
  const groups = isUnknownArray(payload.groups) ? payload.groups : [];
  const preSteps = isUnknownArray(payload.preSteps) ? payload.preSteps : [];
  let commandsCount = 0;
  let actionsCount = 0;
  // Definitions, not placements: a script defined but not yet placed in any
  // step still counts, and a script placed in more than one step (not
  // possible today, but not this function's job to assume) would not be
  // double-counted.
  let preScriptsCount = 0;
  for (const candidate of groups) {
    const group = record(candidate);
    const commands = isUnknownArray(group.commands) ? group.commands : [];
    const actions = isUnknownArray(group.actions) ? group.actions : [];
    const scripts = isUnknownArray(group.preScripts) ? group.preScripts : [];
    commandsCount += commands.length;
    actionsCount += actions.length;
    preScriptsCount += scripts.length;
  }
  return {
    groupsCount: groups.length,
    commandsCount,
    actionsCount,
    preStepsCount: preSteps.length,
    preScriptsCount,
    hasGlobalSettings: isRecord(payload.globalSettings),
  };
}
