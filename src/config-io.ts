import type {
  CustomIcon,
  GlobalSettings,
  Group,
  PreStepScriptRef,
  Workflow,
} from './domain-types.js';
import { normalizeGroup, validateGroupShape } from './groups-model.js';
import {
  applyV3Migration,
  validateLegacySteps,
} from './config-io/legacy-steps.js';
import { migrateIcons } from './groups/icon-migration.js';
import { validateCustomIcons } from './custom-icons.js';
import { normalizeIconColor } from './icon-color.js';
import { validatePipeline } from './pipeline-graph.js';
import { validateWorkflow, workflowsFromPipeline } from './workflows.js';

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

/** A colour that is present but not `#rrggbb` — null/absent mean inherit. */
function invalidIconColor(value: unknown): boolean {
  return value !== undefined && value !== null && !normalizeIconColor(value);
}

/** The first group/command/action of `group` with a malformed icon colour. */
function iconColorError(
  group: UnknownRecord,
  groupLabel: string,
): string | null {
  const nested = [group.commands, group.actions].flatMap((list) =>
    isUnknownArray(list) ? list : [],
  );
  const offender = [group, ...nested].some((entity) =>
    invalidIconColor(record(entity).iconColor),
  );
  return offender
    ? `Grupo "${groupLabel}" tiene un color de icono inválido (debe ser #rrggbb)`
    : null;
}

export interface SerializedConfig {
  exportedAt: string;
  appVersion: string | null;
  version: number;
  groups: Group[];
  workflows: Workflow[];
  globalSettings: Partial<GlobalSettings>;
  /** The uploaded images the exported groups reference. */
  customIcons: CustomIcon[];
}
export interface ImportPayload {
  version: number;
  groups: Group[];
  workflows: Workflow[];
  globalSettings: Partial<GlobalSettings>;
  customIcons: CustomIcon[];
}
export type ImportValidation =
  { ok: true; payload: ImportPayload } | { ok: false; error: string };

export function serializeConfig(
  rawStore:
    | {
        version?: number;
        groups?: Group[];
        workflows?: Workflow[];
        globalSettings?: Partial<GlobalSettings>;
        customIcons?: CustomIcon[];
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
    workflows: Array.isArray(raw.workflows) ? raw.workflows : [],
    globalSettings: raw.globalSettings ?? {},
    customIcons: Array.isArray(raw.customIcons) ? raw.customIcons : [],
  };
}

/**
 * A backup's `workflows`, each validated as strictly as a save from the
 * settings window: same graph rules, refs resolving against the SAME
 * payload's scripts, a single startup workflow, distinct ids.
 */
function validateWorkflows(
  rawWorkflows: readonly unknown[],
  resolves: (ref: PreStepScriptRef) => boolean,
): { ok: true; workflows: Workflow[] } | { ok: false; error: string } {
  const workflows: Workflow[] = [];
  for (const [index, candidate] of rawWorkflows.entries()) {
    const result = validateWorkflow(candidate, { others: workflows, resolves });
    if (!result.ok)
      return { ok: false, error: `Workflow #${index}: ${result.error}` };
    if (workflows.some((w) => w.id === result.workflow.id))
      return { ok: false, error: `Workflow #${index} repite el id de otro` };
    workflows.push(result.workflow);
  }
  return { ok: true, workflows };
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
  const customIcons = validateCustomIcons(value.customIcons);
  if (!customIcons.ok) return customIcons;

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

  // An export from before the graph carries the old ordered `preSteps`
  // instead of `pipeline`: those are validated as strictly as ever, then
  // chained into a graph (`fromLegacySteps`), so old backups keep working.
  const legacyShape =
    value.version === MIN_SUPPORTED_VERSION || value.pipeline === undefined;
  if (legacyShape && rawSteps !== undefined && !isUnknownArray(rawSteps))
    return { ok: false, error: 'preSteps debe ser un array' };
  const preStepsInput = isUnknownArray(rawSteps) ? rawSteps : [];

  const cleanGroups: Group[] = [];
  const scriptIdsByGroup = new Map<string, Set<string>>();
  for (let index = 0; index < rawGroups.length; index++) {
    const rawGroup = record(rawGroups[index]);
    const groupLabel = label(rawGroup, index);
    const colorError = iconColorError(rawGroup, groupLabel);
    if (colorError) return { ok: false, error: colorError };
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
  // place a workflow ref's cross-reference (does {groupId,scriptId} resolve
  // to a real script in this SAME payload?) can be validated.
  const resolves = (ref: PreStepScriptRef): boolean =>
    Boolean(scriptIdsByGroup.get(ref.groupId)?.has(ref.scriptId));
  const settings = record(value.globalSettings);
  let workflows: Workflow[];
  if (isUnknownArray(value.workflows)) {
    const result = validateWorkflows(value.workflows, resolves);
    if (!result.ok) return result;
    workflows = result.workflows;
  } else {
    // A backup from before workflows carries ONE pipeline (a graph, or the
    // older ordered steps): it becomes the startup workflow, armed by the
    // old «Auto al arrancar» — the same conversion the live store applies.
    const pipelineResult = legacyShape
      ? validateLegacySteps(preStepsInput, cleanGroups, scriptIdsByGroup)
      : validatePipeline(value.pipeline, { resolves });
    if (!pipelineResult.ok) return { ok: false, error: pipelineResult.error };
    workflows = workflowsFromPipeline(
      pipelineResult.pipeline,
      migratedAutoRun ?? settings.preScriptsAutoRun === true,
    );
  }

  const cleanGlobalSettings: Partial<GlobalSettings> = {
    autostart: Boolean(settings.autostart),
    silenceWarnings: Boolean(settings.silenceWarnings),
    silenceErrors: Boolean(settings.silenceErrors),
  };
  return {
    ok: true,
    payload: {
      version: EXPORT_SCHEMA_VERSION,
      // An export from before the icon font still carries emoji icons; it
      // gets the same conversion the live store applies on load.
      groups: migrateIcons(cleanGroups).groups,
      workflows,
      globalSettings: cleanGlobalSettings,
      customIcons: customIcons.icons,
    },
  };
}

export function summarizeImport(value: unknown): {
  groupsCount: number;
  commandsCount: number;
  actionsCount: number;
  workflowsCount: number;
  preScriptsCount: number;
  hasGlobalSettings: boolean;
} {
  const payload = record(value);
  const groups = isUnknownArray(payload.groups) ? payload.groups : [];
  const blocks = record(payload.pipeline).blocks;
  // A payload from before workflows holds one pipeline (a graph, or the
  // older steps), which imports as the startup workflow when it has any.
  const legacyPipeline = isUnknownArray(blocks)
    ? blocks
    : isUnknownArray(payload.preSteps)
      ? payload.preSteps
      : [];
  const workflowsCount = isUnknownArray(payload.workflows)
    ? payload.workflows.length
    : legacyPipeline.length > 0
      ? 1
      : 0;
  let commandsCount = 0;
  let actionsCount = 0;
  // Definitions, not placements: a script defined but not yet placed in any
  // block still counts, and a script placed in more than one block (not
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
    workflowsCount,
    preScriptsCount,
    hasGlobalSettings: isRecord(payload.globalSettings),
  };
}
