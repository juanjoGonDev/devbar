/**
 * Raw snapshot → domain shape. Every function here is total: it accepts
 * `unknown` and always returns a fully-formed value, defaulting whatever the
 * input did not carry. The store reads through these on every load, so a
 * default chosen here IS the migration for stores written before the field
 * existed.
 */
import { v4 as uuidv4 } from 'uuid';
import { makePreScriptId } from '../compound-id.js';
import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
  isRecord,
  record,
  stringArray,
  stringValue,
  type UnknownRecord,
} from './raw.js';
import type {
  Action,
  Command,
  ConfirmConfig,
  EnvEntry,
  Group,
  PreScript,
  PreStep,
  PreStepScriptRef,
  Schedule,
  ScheduleRule,
} from '../domain-types.js';

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

/**
 * A step no longer carries script DEFINITIONS, only references into their
 * owning group's flat `preScripts`. Returns `null` for a ref with either id
 * blank, rather than minting placeholder ids for a reference that resolves
 * to nothing.
 */
export function normalizePreStepScriptRef(
  value: unknown,
): PreStepScriptRef | null {
  const raw = record(value);
  const groupId = stringValue(raw.groupId).trim();
  const scriptId = stringValue(raw.scriptId).trim();
  if (!groupId || !scriptId) return null;
  return { groupId, scriptId };
}

export function normalizePreStep(value: unknown): PreStep {
  const raw = record(value);
  const refs = Array.isArray(raw.scripts)
    ? raw.scripts
        .map(normalizePreStepScriptRef)
        .filter((ref): ref is PreStepScriptRef => ref !== null)
    : [];
  // Two refs sharing a {groupId,scriptId} pair resolve to the same process
  // id (`makePreScriptId`); `processManager.start` will not start a second
  // process for a pid already running, so the second ref's `runOne` listener
  // would resolve off the first ref's `action:done` without its script ever
  // actually running. The picker prevents this in the UI, but an imported or
  // hand-edited config does not. Kept first-occurrence, matching every other
  // dedup pass in this file (`reorderByIds`, `migratePreScriptPipeline`'s
  // `knownScriptIds`).
  const seen = new Set<string>();
  const scripts = refs.filter((ref) => {
    const key = makePreScriptId(ref.groupId, ref.scriptId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    id: stringValue(raw.id) || uuidv4(),
    mode: raw.mode === 'serial' ? 'serial' : 'parallel',
    scripts,
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
    preScripts: Array.isArray(raw.preScripts)
      ? raw.preScripts.map(normalizePreScript)
      : [],
    // Existing v4 stores have no such key, so this default IS the decision:
    // it must resolve to "wait" (see Group.waitForPipeline doc).
    waitForPipeline: raw.waitForPipeline !== false,
  };
}
