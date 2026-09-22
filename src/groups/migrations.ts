/**
 * Store/import schema migrations: v1-v2 flat `services` → v3 groups, and v3
 * per-group `preSteps` → the v4 global pipeline. Shared by the live store
 * (`config-store.runMigration`) and config import
 * (`config-io.validateImportedConfig`) so the two never drift apart (D4).
 */
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { makePreScriptId } from '../compound-id.js';
import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
  expandTilde,
  isRecord,
  record,
  stringValue,
  type UnknownRecord,
} from './raw.js';
import {
  materializeEnv,
  normalizeCommand,
  normalizeGroup,
  normalizePreScript,
  normalizePreStep,
} from './normalize.js';
import type {
  Group,
  LegacyService,
  PreScript,
  PreStep,
  PreStepScriptRef,
} from '../domain-types.js';

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
  /** Every {groupId,scriptId} already placed, across ALL steps. */
  const placedRefKeys = new Set<string>(
    existingSteps.flatMap((step) =>
      step.scripts.map((ref) => makePreScriptId(ref.groupId, ref.scriptId)),
    ),
  );
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
          // Across the WHOLE fold, not just this step: two legacy steps
          // carrying the same script id would otherwise place one ref twice,
          // and `validatePipelineSteps` rejects that shape on import — the
          // migration must not mint state the importer refuses.
          const refKey = makePreScriptId(normalized.id, script.id);
          if (placedRefKeys.has(refKey)) continue;
          placedRefKeys.add(refKey);
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
