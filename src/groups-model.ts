import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type {
  Action,
  Command,
  ConfirmConfig,
  EnvEntry,
  Group,
  LegacyService,
  PreScript,
  PreStep,
  Schedule,
  ScheduleRule,
} from './domain-types.js';

const DEFAULT_WARN_REGEX = '\\bwarn(ing)?s?\\b';
const DEFAULT_ERROR_REGEX = '\\berror(s)?\\b';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    // Configs written by the pre-TypeScript versions (or hand-edited) may
    // carry numeric args like ["--port", 3000]; coerce instead of dropping.
    if (typeof item === 'string') result.push(item);
    else if (typeof item === 'number' && Number.isFinite(item))
      result.push(String(item));
  }
  return result;
}

function expandTilde(value: string): string {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function clampMaxLogLinesOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(50_000, Math.max(100, Math.floor(n)));
}

export function clampTimeoutOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3_600_000, Math.max(1000, Math.round(n)));
}

export function clampConfirmSecsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3600, Math.max(3, Math.round(n)));
}

function normalizeScheduleRule(value: unknown): ScheduleRule {
  const raw = record(value);
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(stringValue(raw.time).trim());
  let time = '09:00';
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const days = Array.isArray(raw.days)
    ? [
        ...new Set(
          raw.days
            .filter(
              (day): day is number =>
                Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6,
            )
            .map(Number),
        ),
      ].sort((a, b) => a - b)
    : [];
  return { time, days };
}

export function normalizeSchedule(value: unknown): Schedule {
  const raw = record(value);
  let rules: ScheduleRule[];
  if (Array.isArray(raw.rules)) rules = raw.rules.map(normalizeScheduleRule);
  else if (raw.time !== undefined || raw.days !== undefined)
    rules = [normalizeScheduleRule(raw)];
  else rules = [];
  return { enabled: Boolean(raw.enabled), rules };
}

function normalizeConfirm(value: UnknownRecord): ConfirmConfig {
  const confirm = value.confirm === true;
  const confirmSecs = !confirm
    ? null
    : value.confirmSecs === undefined
      ? 60
      : clampConfirmSecsOrNull(value.confirmSecs);
  return {
    confirm,
    confirmSecs,
    confirmOnTimeout:
      confirm && value.confirmOnTimeout === 'confirm' ? 'confirm' : 'cancel',
  };
}

export function normalizeEnvEntries(value: unknown): EnvEntry[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).map((entry) => ({
      key: stringValue(entry.key),
      value: entry.value == null ? '' : String(entry.value),
      enabled: entry.enabled !== false,
    }));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entryValue]) => ({
      key,
      value: entryValue == null ? '' : String(entryValue),
      enabled: true,
    }));
  }
  return [];
}

export function materializeEnv(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries)) return {};
  const result: Record<string, string> = {};
  for (const candidate of entries) {
    if (
      !isRecord(candidate) ||
      candidate.enabled !== true ||
      typeof candidate.key !== 'string'
    )
      continue;
    const key = candidate.key.trim();
    if (!key) continue;
    result[key] = candidate.value == null ? '' : String(candidate.value);
  }
  return result;
}

export function normalizeCommand(value: unknown): Command {
  const raw = record(value);
  const silenced = record(raw.silencedPatterns);
  return {
    id: stringValue(raw.id) || uuidv4(),
    name: stringValue(raw.name).trim() || 'Unnamed',
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : null,
    command: stringValue(raw.command).trim(),
    args: stringArray(raw.args),
    env: normalizeEnvEntries(raw.env),
    cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd.trim() : null,
    warnRegex: stringValue(raw.warnRegex) || DEFAULT_WARN_REGEX,
    errorRegex: stringValue(raw.errorRegex) || DEFAULT_ERROR_REGEX,
    silenceWarnings: Boolean(raw.silenceWarnings),
    silenceErrors: Boolean(raw.silenceErrors),
    silencedPatterns: {
      warn: stringArray(silenced.warn),
      error: stringArray(silenced.error),
    },
    autoStart: Boolean(raw.autoStart),
    schedule: normalizeSchedule(raw.schedule),
    maxLogLines: clampMaxLogLinesOrNull(raw.maxLogLines),
    ...normalizeConfirm(raw),
  };
}

export function normalizeAction(value: unknown): Action {
  const raw = record(value);
  const inheritGroupEnv =
    typeof raw.inheritGroupEnv === 'boolean'
      ? raw.inheritGroupEnv
      : typeof raw.useEnvs === 'boolean'
        ? raw.useEnvs
        : false;
  return {
    id: stringValue(raw.id) || uuidv4(),
    name: stringValue(raw.name).trim() || 'Unnamed',
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : null,
    command: stringValue(raw.command).trim(),
    args: stringArray(raw.args),
    env: normalizeEnvEntries(raw.env),
    inheritGroupEnv,
    schedule: normalizeSchedule(raw.schedule),
    ...normalizeConfirm(raw),
  };
}

export function normalizePreScript(value: unknown): PreScript {
  const raw = record(value);
  return {
    id: stringValue(raw.id) || uuidv4(),
    name: stringValue(raw.name).trim() || 'Unnamed',
    command: stringValue(raw.command).trim(),
    args: stringArray(raw.args),
    env: normalizeEnvEntries(raw.env),
    inheritGroupEnv:
      typeof raw.inheritGroupEnv === 'boolean' ? raw.inheritGroupEnv : false,
    timeoutMs: clampTimeoutOrNull(raw.timeoutMs),
    ...normalizeConfirm(raw),
  };
}

export function normalizePreStep(value: unknown): PreStep {
  const raw = record(value);
  return {
    id: stringValue(raw.id) || uuidv4(),
    mode: raw.mode === 'serial' ? 'serial' : 'parallel',
    scripts: Array.isArray(raw.scripts)
      ? raw.scripts.map(normalizePreScript)
      : [],
  };
}

export function normalizeGroup(value: unknown): Group {
  const raw = record(value);
  return {
    id: stringValue(raw.id) || uuidv4(),
    name: stringValue(raw.name).trim() || 'Servicios',
    icon: stringValue(raw.icon) || '📦',
    path: stringValue(raw.path).trim(),
    mode: raw.mode === 'single' ? 'single' : 'multi',
    order: typeof raw.order === 'number' ? raw.order : 0,
    silenceWarnings: Boolean(raw.silenceWarnings),
    silenceErrors: Boolean(raw.silenceErrors),
    env: normalizeEnvEntries(raw.env),
    commands: Array.isArray(raw.commands)
      ? raw.commands.map(normalizeCommand)
      : [],
    actions: Array.isArray(raw.actions) ? raw.actions.map(normalizeAction) : [],
    preSteps: Array.isArray(raw.preSteps)
      ? raw.preSteps.map(normalizePreStep)
      : [],
    preScriptsAutoRun: Boolean(raw.preScriptsAutoRun),
  };
}

export function bucketKeyFor(value: unknown): string {
  const raw = record(value);
  const gitRepo = stringValue(raw.gitRepo).trim();
  const cwd = stringValue(raw.cwd).trim();
  return expandTilde(gitRepo || cwd || '');
}

export function regenerateLegacyServices(
  groups: readonly Group[],
): LegacyService[] {
  const services: LegacyService[] = [];
  for (const group of groups) {
    for (const command of group.commands) {
      services.push({
        id: command.id,
        name: command.name,
        cwd: command.cwd || group.path,
        command: command.command,
        args: command.args,
        env: materializeEnv(command.env),
        gitRepo: group.path,
        warnRegex: command.warnRegex || DEFAULT_WARN_REGEX,
        errorRegex: command.errorRegex || DEFAULT_ERROR_REGEX,
        silenceWarnings: Boolean(
          group.silenceWarnings || command.silenceWarnings,
        ),
        silenceErrors: Boolean(group.silenceErrors || command.silenceErrors),
        silencedPatterns: command.silencedPatterns,
      });
    }
  }
  return services;
}

export interface MigratedState {
  version: number;
  groups: Group[];
  services: LegacyService[];
  _services_pre_v3_backup?: unknown[];
  [key: string]: unknown;
}

export function migrateServicesToGroups(value: unknown): {
  changed: boolean;
  state: MigratedState;
} {
  const raw = record(value);
  const version = typeof raw.version === 'number' ? raw.version : 1;
  if (version === 3 && Array.isArray(raw.groups)) {
    const groups = raw.groups.map(normalizeGroup);
    // Ids feed compound process ids and scheduleState keys, so a missing or
    // non-string id must be repaired AND persisted here — normalizeGroup
    // would otherwise mint a different uuid on every read.
    const hasStableId = (item: UnknownRecord): boolean =>
      typeof item.id === 'string' && item.id !== '';
    const canonical = raw.groups.every((candidate, index) => {
      const item = record(candidate);
      const normalized = groups[index];
      return (
        normalized !== undefined &&
        hasStableId(item) &&
        Array.isArray(item.env) &&
        Array.isArray(item.commands) &&
        item.commands.every(
          (command) =>
            hasStableId(record(command)) &&
            Array.isArray(record(command).env) &&
            typeof record(command).autoStart === 'boolean',
        ) &&
        Array.isArray(item.actions) &&
        item.actions.every(
          (action) =>
            hasStableId(record(action)) &&
            Array.isArray(record(action).env) &&
            typeof record(action).inheritGroupEnv === 'boolean' &&
            !('useEnvs' in record(action)),
        ) &&
        (!Array.isArray(item.preSteps) ||
          item.preSteps.every((step) => {
            const stepRecord = record(step);
            return (
              hasStableId(stepRecord) &&
              (!Array.isArray(stepRecord.scripts) ||
                stepRecord.scripts.every((script) =>
                  hasStableId(record(script)),
                ))
            );
          }))
      );
    });
    const state: MigratedState = {
      ...raw,
      version: 3,
      groups,
      services: regenerateLegacyServices(groups),
    };
    return { changed: !canonical, state };
  }

  const legacy = Array.isArray(raw.services)
    ? raw.services.filter(isRecord)
    : [];
  const buckets = new Map<string, UnknownRecord[]>();
  const order: string[] = [];
  for (const service of legacy) {
    const key = bucketKeyFor(service);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)?.push(service);
  }
  const groups = order.map((key, index) => {
    const services = buckets.get(key) ?? [];
    return normalizeGroup({
      id: uuidv4(),
      name: key ? path.basename(key) || 'Servicios' : '(no path)',
      icon: '📦',
      path: key,
      mode: 'multi',
      order: index,
      silenceWarnings: false,
      silenceErrors: false,
      commands: services.map((service) => {
        const expandedCwd = expandTilde(stringValue(service.cwd).trim());
        return normalizeCommand({
          ...service,
          cwd: expandedCwd && expandedCwd !== key ? service.cwd : null,
          icon: null,
        });
      }),
      actions: [],
    });
  });
  const state: MigratedState = {
    ...raw,
    version: 3,
    groups,
    services: regenerateLegacyServices(groups),
    _services_pre_v3_backup: Array.isArray(raw._services_pre_v3_backup)
      ? raw._services_pre_v3_backup
      : legacy,
  };
  return { changed: true, state };
}

export function enforceSingleModeAutoStart(group: Group): {
  group: Group;
  changed: boolean;
};
export function enforceSingleModeAutoStart(group: null): {
  group: null;
  changed: boolean;
};
export function enforceSingleModeAutoStart(group: undefined): {
  group: undefined;
  changed: boolean;
};
export function enforceSingleModeAutoStart(group: Group | null | undefined): {
  group: Group | null | undefined;
  changed: boolean;
} {
  if (!group || group.mode !== 'single') return { group, changed: false };
  const flagged = group.commands.filter((command) => command.autoStart).length;
  if (flagged <= 1) return { group, changed: false };
  return {
    group: {
      ...group,
      commands: group.commands.map((command) =>
        command.autoStart ? { ...command, autoStart: false } : command,
      ),
    },
    changed: true,
  };
}

export function validateGroupShape(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isRecord(value))
    return { valid: false, errors: ['Group is null or undefined'] };
  if (typeof value.path !== 'string' || !value.path.trim())
    errors.push('Group path must not be empty');
  if (typeof value.name !== 'string' || !value.name.trim())
    errors.push('Group name must not be empty');
  if (value.mode !== 'single' && value.mode !== 'multi')
    errors.push('Group mode must be "single" or "multi"');
  if (value.preSteps !== undefined) {
    if (!Array.isArray(value.preSteps))
      errors.push('preSteps must be an array');
    else
      value.preSteps.forEach((candidate, stepIndex) => {
        if (!isRecord(candidate)) {
          errors.push(`preSteps[${stepIndex}] must be an object`);
          return;
        }
        if (!candidate.id) errors.push(`preSteps[${stepIndex}] missing id`);
        if (candidate.mode !== 'parallel' && candidate.mode !== 'serial')
          errors.push(
            `preSteps[${stepIndex}] mode must be "parallel" or "serial"`,
          );
        if (!Array.isArray(candidate.scripts))
          errors.push(`preSteps[${stepIndex}] scripts must be an array`);
        else
          candidate.scripts.forEach((script, scriptIndex) => {
            if (!isRecord(script)) {
              errors.push(
                `preSteps[${stepIndex}].scripts[${scriptIndex}] must be an object`,
              );
              return;
            }
            if (!script.id)
              errors.push(
                `preSteps[${stepIndex}].scripts[${scriptIndex}] missing id`,
              );
            if (!script.name)
              errors.push(
                `preSteps[${stepIndex}].scripts[${scriptIndex}] missing name`,
              );
            if (script.command === undefined || script.command === null)
              errors.push(
                `preSteps[${stepIndex}].scripts[${scriptIndex}] missing command`,
              );
          });
      });
  }
  return { valid: errors.length === 0, errors };
}
