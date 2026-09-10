import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { makePreScriptId } from './compound-id.js';
import type {
  Action,
  Command,
  ConfirmConfig,
  EnvEntry,
  Group,
  LegacyService,
  PreScript,
  PreStep,
  PreStepScriptRef,
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
  if ((version === 3 || version === 4) && Array.isArray(raw.groups)) {
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
        (!Array.isArray(item.preScripts) ||
          item.preScripts.every((script) => hasStableId(record(script))))
      );
    });
    const state: MigratedState = {
      ...raw,
      // v4 groups are re-checked by this same canonical pass (flat
      // `preScripts` replaces nested `preSteps`), so the input version must
      // survive unchanged here — this branch no longer only means "v3".
      version,
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

/**
 * Mints an id guaranteed not to collide with `used`. Step ids were
 * group-scoped before this migration and are global afterwards, so two
 * legacy steps can legitimately carry the same literal id; falling back to a
 * fresh uuid is not itself enough to guarantee uniqueness (a test double, or
 * a pathological real UUID clash), hence the numbered-suffix loop.
 */
function mintUniqueId(used: ReadonlySet<string>): string {
  const base = uuidv4();
  if (!used.has(base)) return base;
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/**
 * One-time (but idempotent) v3→v4 migration: concatenates every group's old
 * per-group `preSteps` into the new global pipeline, hoisting each step's
 * inline script definitions into that group's flat `preScripts`. Shared by
 * the live store (`config-store.runMigration`) and config import
 * (`config-io.validateImportedConfig`) so the two never drift apart (D4).
 *
 * Idempotency relies on reading ONLY the legacy `preSteps`/`preScriptsAutoRun`
 * keys off each raw group: the v4 writer never emits them, so re-running this
 * against already-migrated state is a no-op walk that changes nothing.
 */
export function migratePreScriptPipeline(raw: {
  groups?: unknown[];
  preSteps?: unknown;
  globalSettings?: unknown;
}): {
  changed: boolean;
  groups: Group[];
  preSteps: PreStep[];
  /**
   * Only the steps actually hoisted from legacy PER-GROUP data — never the
   * pre-existing top-level `preSteps` folded into `preSteps` above. The
   * importer (`config-io.ts`) needs this split so it can keep validating the
   * payload's OWN raw top-level steps strictly, instead of trusting this
   * function's normalized (leniently-defaulted) pass-through of them.
   */
  hoistedSteps: PreStep[];
  preScriptsAutoRun: boolean;
  /**
   * How many groups actually contributed >=1 script to the fold above. Lets
   * a caller (`planStoreMigration`) tell "zero groups contributed a real
   * legacy pre-script step" apart from "something else about this raw
   * snapshot needed normalizing" — `changed` alone conflates the two, and
   * using it to gate whether to WRITE `preScriptsAutoRun` would silently
   * disable a user's real setting the moment ANY group carries a stale,
   * contribution-free legacy key (e.g. an empty `preSteps: []`).
   */
  preScriptsAutoRunContributors: number;
} {
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  // Preserve original array position for the output `groups` order, but walk
  // in `order` order (with a stable index tie-break) to decide global step
  // concatenation order — the store persists `order` but never guarantees
  // the array itself is sorted by it.
  const indexed = rawGroups.map((item, index) => ({
    raw: record(item),
    index,
  }));
  const walkOrder = [...indexed].sort((a, b) => {
    const orderA = typeof a.raw.order === 'number' ? a.raw.order : 0;
    const orderB = typeof b.raw.order === 'number' ? b.raw.order : 0;
    return orderA - orderB || a.index - b.index;
  });

  // Normalized FIRST — and its ids seeded into `usedStepIds` below — so a
  // migrated legacy step can never mint or reuse an id that collides with
  // one an existing top-level step already has. `savePreStep`, `deletePreStep`
  // and `reorderPreSteps` all address steps by id alone, so a collision would
  // make them hit the wrong step.
  const existingSteps = Array.isArray(raw.preSteps)
    ? raw.preSteps.map(normalizePreStep)
    : [];

  let changed = false;
  const usedStepIds = new Set<string>(existingSteps.map((step) => step.id));
  const newSteps: PreStep[] = [];
  const contributorAutoRuns: boolean[] = [];
  const mergedByIndex = new Map<number, Group>();

  for (const { raw: rawGroup, index } of walkOrder) {
    const hasLegacySteps = Array.isArray(rawGroup.preSteps);
    if (hasLegacySteps || 'preScriptsAutoRun' in rawGroup) changed = true;

    const normalized = normalizeGroup(rawGroup);
    const knownScriptIds = new Set(normalized.preScripts.map((s) => s.id));
    const hoisted: PreScript[] = [];
    let contributed = false;

    if (hasLegacySteps) {
      for (const rawStep of rawGroup.preSteps as unknown[]) {
        const legacyStep = record(rawStep);
        const legacyScripts = Array.isArray(legacyStep.scripts)
          ? legacyStep.scripts
          : [];
        const refs: PreStepScriptRef[] = [];
        for (const rawScript of legacyScripts) {
          const script = normalizePreScript(rawScript);
          if (!knownScriptIds.has(script.id)) {
            knownScriptIds.add(script.id);
            hoisted.push(script);
          }
          refs.push({ groupId: normalized.id, scriptId: script.id });
        }
        if (refs.length === 0) continue;
        contributed = true;
        const legacyId = stringValue(legacyStep.id);
        const stepId =
          legacyId && !usedStepIds.has(legacyId)
            ? legacyId
            : mintUniqueId(usedStepIds);
        usedStepIds.add(stepId);
        newSteps.push({
          id: stepId,
          mode: legacyStep.mode === 'serial' ? 'serial' : 'parallel',
          scripts: refs,
        });
      }
    }

    mergedByIndex.set(index, {
      ...normalized,
      preScripts: [...normalized.preScripts, ...hoisted],
    });
    if (contributed) {
      contributorAutoRuns.push(rawGroup.preScriptsAutoRun === true);
    }
  }

  // An OR-merge would auto-run, at login, a script belonging to a group that
  // had explicitly opted out — an unrecoverable "ran an unauthorized setup
  // script at boot" versus a recoverable one-click "did not run". Zero
  // contributors folds to false rather than leaving a stale prior value.
  const preScriptsAutoRun =
    contributorAutoRuns.length > 0 && contributorAutoRuns.every(Boolean);

  return {
    changed,
    groups: indexed.map(({ index }) => mergedByIndex.get(index) as Group),
    preSteps: [...existingSteps, ...newSteps],
    hoistedSteps: newSteps,
    preScriptsAutoRun,
    preScriptsAutoRunContributors: contributorAutoRuns.length,
  };
}

export interface StoreMigrationInput {
  version?: number;
  groups?: unknown[];
  services?: unknown[];
  preSteps?: unknown;
  globalSettings?: unknown;
  _services_pre_v3_backup?: unknown[];
}

export interface StoreMigrationPlan {
  /** Whether `config-store.ts` needs to write anything back to disk. */
  changed: boolean;
  version: number;
  groups: Group[];
  services: LegacyService[];
  preSteps: PreStep[];
  /** `null` means "leave `globalSettings.preScriptsAutoRun` untouched". */
  preScriptsAutoRun: boolean | null;
  /** `null` means "leave `_services_pre_v3_backup` untouched". */
  servicesBackup: unknown[] | null;
}

/**
 * Pure composition of the store's two migrations, extracted so the version-
 * labelling bug (sdd-verify C1's producer) is provable without
 * electron-store, which cannot be imported under Vitest (see
 * `config-store.ts`'s own docstring) — the `autostart-schedule.ts`
 * precedent for a testable seam over Electron-bound code.
 *
 * Runs `migratePreScriptPipeline` FIRST, against the PRISTINE raw snapshot —
 * `normalizeGroup` (inside `migrateServicesToGroups`) silently drops legacy
 * `preSteps`/`preScriptsAutoRun`, so hoisting must see the raw group before
 * that happens (the batch-1 ordering fix). THEN runs `migrateServicesToGroups`
 * (id-repair / legacy v1-v2→v3 conversion) against whatever the pipeline step
 * produced — the two are NOT mutually exclusive, matching the design's
 * "then": a store needing both a hoist and an id repair gets both in one
 * pass, instead of the id-repair pass being skipped whenever hoisting ran.
 *
 * The store is v4-shaped the instant this function has run once: there is no
 * persisted state that is meaningfully "v3" afterward. `changed` is true
 * whenever EITHER migration did real work, OR the on-disk version does not
 * already say so — the latter is what keeps a store whose CONTENT needed no
 * change (e.g. an empty `groups` array) from staying mislabelled v3 forever,
 * which is what silently poisoned every export/backup of that store
 * (sdd-verify C1).
 */
export function planStoreMigration(
  raw: StoreMigrationInput,
): StoreMigrationPlan {
  const pipeline = migratePreScriptPipeline(raw);
  const idRepair = migrateServicesToGroups({ ...raw, groups: pipeline.groups });
  const currentVersion = typeof raw.version === 'number' ? raw.version : 1;
  const changed = pipeline.changed || idRepair.changed || currentVersion !== 4;
  const groups = idRepair.changed ? idRepair.state.groups : pipeline.groups;
  const services = idRepair.changed
    ? idRepair.state.services
    : regenerateLegacyServices(pipeline.groups);
  return {
    changed,
    version: 4,
    groups,
    services,
    preSteps: pipeline.preSteps,
    // Gated on real contributors, NOT on `pipeline.changed`: a group can flip
    // `changed` to true (a stale `preScriptsAutoRun` key, or an empty legacy
    // `preSteps: []`) without ever contributing a script to the fold. Gating
    // on `changed` there would write the AND-fold's zero-contributor `false`
    // over a user's real `globalSettings.preScriptsAutoRun`, silently
    // disabling an auto-run they had actually enabled.
    preScriptsAutoRun:
      pipeline.preScriptsAutoRunContributors > 0
        ? pipeline.preScriptsAutoRun
        : null,
    servicesBackup:
      idRepair.changed && Array.isArray(idRepair.state._services_pre_v3_backup)
        ? idRepair.state._services_pre_v3_backup
        : null,
  };
}

/**
 * Referential-integrity pass for the global pipeline: drops any ref whose
 * group or script no longer exists. Mirrors `regenerateLegacyServices` —
 * called by the persist helper on every write, not bolted onto individual
 * delete call sites, so every future write path gets it for free (D5).
 *
 * A step that becomes empty is KEPT: it is a user-authored ordering slot,
 * and the editor already creates empty steps deliberately.
 */
export function prunePipelineRefs(
  steps: readonly PreStep[],
  groups: readonly Group[],
): PreStep[] {
  const scriptIdsByGroup = new Map<string, Set<string>>();
  for (const group of groups) {
    scriptIdsByGroup.set(
      group.id,
      new Set(group.preScripts.map((script) => script.id)),
    );
  }
  return steps.map((step) => ({
    ...step,
    scripts: step.scripts.filter((ref) =>
      Boolean(scriptIdsByGroup.get(ref.groupId)?.has(ref.scriptId)),
    ),
  }));
}

/**
 * Reorders `items` to match `orderedIds`: known ids come first, in that
 * exact order (a repeated id only counts once); any item whose id is not in
 * `orderedIds` is appended afterward, in its original relative order.
 * Shared by every id-ordered CRUD list in `config-store.ts` — groups,
 * commands, actions, pre-steps, and pre-scripts all reorder the same way
 * (sdd-verify W3: previously a private helper there, and hand-copied again
 * inside a test file since `config-store.ts` cannot be imported under
 * Vitest; now real and imported by both).
 */
export function reorderByIds<T extends { id: string }>(
  items: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const sorted: T[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      sorted.push(item);
      seen.add(id);
    }
  }
  for (const item of items) if (!seen.has(item.id)) sorted.push(item);
  return sorted;
}

/**
 * Places `ref` into `stepId` at `position` (end of the step when omitted),
 * first removing it from EVERY step (including the target). This single
 * function covers a fresh placement, a cross-step move, and a same-step
 * reorder — all are just "this ref now lives at this position in this
 * step" — so the renderer's cross-container drag needs exactly one call.
 */
export function assignScriptToStep(
  steps: readonly PreStep[],
  stepId: string,
  ref: PreStepScriptRef,
  position?: number,
): PreStep[] {
  // A stale/unknown stepId must not silently unassign the ref: removing it
  // from wherever it currently lives, with no matching step to re-insert it
  // into, would leave it placed nowhere — and `config-store` persists
  // whatever this function returns.
  if (!steps.some((step) => step.id === stepId)) return [...steps];
  const isSameRef = (candidate: PreStepScriptRef): boolean =>
    candidate.groupId === ref.groupId && candidate.scriptId === ref.scriptId;
  const withoutRefAnywhere = steps.map((step) => ({
    ...step,
    scripts: step.scripts.filter((existing) => !isSameRef(existing)),
  }));
  return withoutRefAnywhere.map((step) => {
    if (step.id !== stepId) return step;
    const insertAt =
      position === undefined
        ? step.scripts.length
        : Math.max(0, Math.min(position, step.scripts.length));
    return {
      ...step,
      scripts: [
        ...step.scripts.slice(0, insertAt),
        ref,
        ...step.scripts.slice(insertAt),
      ],
    };
  });
}

/** Removes `ref` from `stepId` only, leaving every other step untouched. */
export function unassignScriptFromStep(
  steps: readonly PreStep[],
  stepId: string,
  ref: PreStepScriptRef,
): PreStep[] {
  return steps.map((step) => {
    if (step.id !== stepId) return step;
    return {
      ...step,
      scripts: step.scripts.filter(
        (existing) =>
          !(
            existing.groupId === ref.groupId &&
            existing.scriptId === ref.scriptId
          ),
      ),
    };
  });
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
  if (value.preScripts !== undefined) {
    if (!Array.isArray(value.preScripts))
      errors.push('preScripts must be an array');
    else
      value.preScripts.forEach((script, scriptIndex) => {
        if (!isRecord(script)) {
          errors.push(`preScripts[${scriptIndex}] must be an object`);
          return;
        }
        if (!script.id) errors.push(`preScripts[${scriptIndex}] missing id`);
        if (!script.name)
          errors.push(`preScripts[${scriptIndex}] missing name`);
        if (script.command === undefined || script.command === null)
          errors.push(`preScripts[${scriptIndex}] missing command`);
      });
  }
  return { valid: errors.length === 0, errors };
}
