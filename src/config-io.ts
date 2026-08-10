import type { GlobalSettings, Group } from './domain-types.js';
import { normalizeGroup, validateGroupShape } from './groups-model.js';

export const EXPORT_SCHEMA_VERSION = 3;
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
  globalSettings: Partial<GlobalSettings>;
}
export interface ImportPayload {
  version: number;
  groups: Group[];
  globalSettings: Partial<GlobalSettings>;
}
export type ImportValidation =
  { ok: true; payload: ImportPayload } | { ok: false; error: string };

export function serializeConfig(
  rawStore:
    | {
        version?: number;
        groups?: Group[];
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
    globalSettings: raw.globalSettings ?? {},
  };
}

export function validateImportedConfig(value: unknown): ImportValidation {
  if (!isRecord(value))
    return { ok: false, error: 'Root must be a JSON object' };
  if (value.version !== EXPORT_SCHEMA_VERSION)
    return {
      ok: false,
      error: `Versión de schema incompatible (esperada ${EXPORT_SCHEMA_VERSION}, recibida ${String(value.version)})`,
    };
  if (!isUnknownArray(value.groups))
    return { ok: false, error: 'groups debe ser un array' };
  const cleanGroups: Group[] = [];
  for (let index = 0; index < value.groups.length; index++) {
    const rawGroup = record(value.groups[index]);
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
    const preSteps = isUnknownArray(rawGroup.preSteps) ? rawGroup.preSteps : [];
    for (let stepIndex = 0; stepIndex < preSteps.length; stepIndex++) {
      const step = record(preSteps[stepIndex]);
      if (
        step.mode !== undefined &&
        step.mode !== 'parallel' &&
        step.mode !== 'serial'
      )
        return {
          ok: false,
          error: `Grupo "${groupLabel}" paso #${stepIndex} con mode inválido`,
        };
      if (step.scripts !== undefined && !isUnknownArray(step.scripts))
        return {
          ok: false,
          error: `Grupo "${groupLabel}" paso #${stepIndex} scripts debe ser array`,
        };
      const scripts = isUnknownArray(step.scripts) ? step.scripts : [];
      for (const candidate of scripts) {
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
    }
    const group = normalizeGroup(rawGroup);
    const validation = validateGroupShape(group);
    if (!validation.valid)
      return {
        ok: false,
        error: `Grupo #${index} "${group.name}": ${validation.errors.join(', ')}`,
      };
    cleanGroups.push(group);
  }
  const settings = record(value.globalSettings);
  const cleanGlobalSettings: Partial<GlobalSettings> = {
    autostart: Boolean(settings.autostart),
    silenceWarnings: Boolean(settings.silenceWarnings),
    silenceErrors: Boolean(settings.silenceErrors),
  };
  return {
    ok: true,
    payload: {
      version: EXPORT_SCHEMA_VERSION,
      groups: cleanGroups,
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
  let commandsCount = 0;
  let actionsCount = 0;
  let preStepsCount = 0;
  let preScriptsCount = 0;
  for (const candidate of groups) {
    const group = record(candidate);
    const commands = isUnknownArray(group.commands) ? group.commands : [];
    const actions = isUnknownArray(group.actions) ? group.actions : [];
    const preSteps = isUnknownArray(group.preSteps) ? group.preSteps : [];
    commandsCount += commands.length;
    actionsCount += actions.length;
    preStepsCount += preSteps.length;
    for (const candidateStep of preSteps) {
      const step = record(candidateStep);
      preScriptsCount += isUnknownArray(step.scripts) ? step.scripts.length : 0;
    }
  }
  return {
    groupsCount: groups.length,
    commandsCount,
    actionsCount,
    preStepsCount,
    preScriptsCount,
    hasGlobalSettings: isRecord(payload.globalSettings),
  };
}
