'use strict';

/**
 * groups-model.js — pure, Electron-free module for the v3 data model.
 *
 * Exports:
 *   normalizeGroup(input)           → Group (throws on empty path)
 *   normalizeCommand(input)         → Command
 *   normalizeAction(input)          → Action
 *   normalizeEnvEntries(raw)        → EnvEntry[]
 *   materializeEnv(entries)         → { KEY: VALUE } (only enabled, non-empty-key entries)
 *   bucketKeyFor(svc)               → string (expanded path key used for grouping)
 *   migrateServicesToGroups(state)  → { changed: boolean, state: object }
 *   regenerateLegacyServices(groups) → Service[] (flat legacy array)
 *   validateGroupShape(group)       → { valid: boolean, errors: string[] }
 */

const path = require('path');
const os = require('os');

// Inline expandTilde so this module has zero Electron deps.
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Dynamically require uuid so tests can stub it if needed, but fall back to
// a simple random generator so the module works even without the package.
function uuidv4() {
  try {
    return require('uuid').v4();
  } catch (_) {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

const DEFAULT_WARN_REGEX = '\\bwarn(ing)?s?\\b';
const DEFAULT_ERROR_REGEX = '\\berror(s)?\\b';

/**
 * Clamp a maxLogLines value for a command: returns null for missing/empty/invalid,
 * otherwise clamps to [100, 50000]. null means "use global default".
 */
function clampMaxLogLinesOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(50000, Math.max(100, Math.floor(n)));
}

// ─────────────────────── Env helpers ────────────────────────────────

/**
 * Normalize a raw env value into EnvEntry[].
 * Accepts:
 *   - already-array form  → passed through (each entry normalized)
 *   - legacy object form  → converted to array with enabled:true
 *   - null/undefined/other → []
 */
function normalizeEnvEntries(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
      .map((e) => ({
        key: typeof e.key === 'string' ? e.key : '',
        value: typeof e.value === 'string' ? e.value : String(e.value == null ? '' : e.value),
        enabled: e.enabled !== false, // default true
      }));
  }
  if (raw && typeof raw === 'object') {
    // Legacy object shape { KEY: VALUE }
    return Object.entries(raw).map(([key, value]) => ({
      key,
      value: String(value == null ? '' : value),
      enabled: true,
    }));
  }
  return [];
}

/**
 * Build a plain env object from EnvEntry[] for spawning.
 * Only entries where enabled === true AND key.trim() !== '' are included.
 */
function materializeEnv(entries) {
  if (!Array.isArray(entries)) return {};
  const result = {};
  for (const e of entries) {
    if (e && e.enabled && typeof e.key === 'string' && e.key.trim() !== '') {
      result[e.key.trim()] = typeof e.value === 'string' ? e.value : String(e.value == null ? '' : e.value);
    }
  }
  return result;
}

// ─────────────────────── Normalizers ────────────────────────────

/**
 * Normalize a raw Group object. Throws if path is empty.
 */
function normalizeGroup(input) {
  const raw = input || {};
  const groupPath = (raw.path || '').trim();
  // Empty path is allowed only for the special "(no path)" bucket.
  // The caller (migration) uses '' deliberately for that bucket.
  // validateGroupShape() separately enforces the non-empty constraint at save time.
  return {
    id: raw.id || uuidv4(),
    name: (raw.name || '').trim() || 'Servicios',
    icon: raw.icon || '📦',
    path: groupPath,
    mode: raw.mode === 'single' ? 'single' : 'multi',
    order: typeof raw.order === 'number' ? raw.order : 0,
    silenceWarnings: !!raw.silenceWarnings,
    silenceErrors: !!raw.silenceErrors,
    env: normalizeEnvEntries(raw.env),
    commands: Array.isArray(raw.commands) ? raw.commands.map(normalizeCommand) : [],
    actions: Array.isArray(raw.actions) ? raw.actions.map(normalizeAction) : [],
    preSteps: Array.isArray(raw.preSteps) ? raw.preSteps.map(normalizePreStep) : [],
    // When true, pre-scripts run automatically — but ONLY when DevBar was
    // launched by macOS at login (i.e. system boot), not on every manual
    // app restart. Default false so the user opts in explicitly.
    preScriptsAutoRun: !!raw.preScriptsAutoRun,
  };
}

/**
 * Normalize a raw Command object.
 */
function normalizeCommand(input) {
  const raw = input || {};
  const sp = raw.silencedPatterns || {};
  return {
    id: raw.id || uuidv4(),
    name: (raw.name || '').trim() || 'Unnamed',
    icon: raw.icon || null,
    command: (raw.command || '').trim(),
    args: Array.isArray(raw.args) ? raw.args.slice() : [],
    env: normalizeEnvEntries(raw.env),
    cwd: raw.cwd ? (raw.cwd || '').trim() : null,
    warnRegex: raw.warnRegex || DEFAULT_WARN_REGEX,
    errorRegex: raw.errorRegex || DEFAULT_ERROR_REGEX,
    silenceWarnings: !!raw.silenceWarnings,
    silenceErrors: !!raw.silenceErrors,
    silencedPatterns: {
      warn: Array.isArray(sp.warn) ? sp.warn.slice() : [],
      error: Array.isArray(sp.error) ? sp.error.slice() : [],
    },
    autoStart: !!raw.autoStart,
    maxLogLines: clampMaxLogLinesOrNull(raw.maxLogLines),
  };
}

/**
 * Normalize a raw PreScript object.
 * Mirrors normalizeAction shape minus icon, warnRegex, errorRegex, etc.
 */
function normalizePreScript(input) {
  const raw = input || {};
  return {
    id: raw.id || uuidv4(),
    name: (raw.name || '').trim() || 'Unnamed',
    command: (raw.command || '').trim(),
    args: Array.isArray(raw.args) ? raw.args.slice() : [],
    env: normalizeEnvEntries(raw.env),
    inheritGroupEnv: typeof raw.inheritGroupEnv === 'boolean' ? raw.inheritGroupEnv : false,
  };
}

/**
 * Normalize a raw PreStep object.
 * mode defaults to 'parallel' for any unknown/missing value.
 */
function normalizePreStep(input) {
  const raw = input || {};
  return {
    id: raw.id || uuidv4(),
    mode: raw.mode === 'serial' ? 'serial' : 'parallel',
    scripts: Array.isArray(raw.scripts) ? raw.scripts.map(normalizePreScript) : [],
  };
}

/**
 * Normalize a raw Action object.
 * inheritGroupEnv defaults to false for brand-new actions.
 * Legacy useEnvs is migrated to inheritGroupEnv in migrateServicesToGroups.
 */
function normalizeAction(input) {
  const raw = input || {};
  const envEntries = normalizeEnvEntries(raw.env);
  // Support reading either the new field or the legacy useEnvs field.
  // normalizeAction itself always outputs inheritGroupEnv.
  let inheritGroupEnv;
  if (typeof raw.inheritGroupEnv === 'boolean') {
    inheritGroupEnv = raw.inheritGroupEnv;
  } else if (typeof raw.useEnvs === 'boolean') {
    // Transparently migrate legacy field on read
    inheritGroupEnv = raw.useEnvs;
  } else {
    inheritGroupEnv = false;
  }
  return {
    id: raw.id || uuidv4(),
    name: (raw.name || '').trim() || 'Unnamed',
    icon: raw.icon || null,
    command: (raw.command || '').trim(),
    args: Array.isArray(raw.args) ? raw.args.slice() : [],
    env: envEntries,
    inheritGroupEnv,
  };
}

// ─────────────────────── Bucket key ─────────────────────────────

/**
 * Derive the grouping key for a legacy service.
 * Uses expandTilde(gitRepo || cwd || '').
 */
function bucketKeyFor(svc) {
  const raw = ((svc.gitRepo || '').trim()) || ((svc.cwd || '').trim()) || '';
  return expandTilde(raw);
}

// ─────────────────────── Migration v1 → v3 ──────────────────────

/**
 * Migrate a raw electron-store state from v1 (flat services) to v3 (groups).
 * Also handles shape-only env migration (object → EnvEntry[]) for existing v3 states.
 * This function is pure and idempotent.
 *
 * Returns { changed: boolean, state: object }
 */
function migrateServicesToGroups(state) {
  const s = state || {};

  // ── Shape-only env migration for existing v3 states ─────────────────────────
  // If already on v3 with groups, we may still need to migrate env from object
  // to EnvEntry[] and add useEnvs/group.env fields.
  if (
    s.version === 3 &&
    Array.isArray(s.groups)
  ) {
    let needsEnvMigration = false;

    // Check if any group, command, or action needs env shape migration
    for (const g of s.groups) {
      if (!Array.isArray(g.env)) { needsEnvMigration = true; break; }
      for (const cmd of (g.commands || [])) {
        if (!Array.isArray(cmd.env)) { needsEnvMigration = true; break; }
        // Shape-fix: commands that lack autoStart field (boolean) need migration
        if (typeof cmd.autoStart !== 'boolean') { needsEnvMigration = true; break; }
      }
      if (needsEnvMigration) break;
      for (const act of (g.actions || [])) {
        if (!Array.isArray(act.env)) { needsEnvMigration = true; break; }
        // Needs migration if: has useEnvs (legacy) OR lacks inheritGroupEnv (new field)
        if (typeof act.inheritGroupEnv !== 'boolean') { needsEnvMigration = true; break; }
        if ('useEnvs' in act) { needsEnvMigration = true; break; }
      }
      if (needsEnvMigration) break;
    }

    if (!needsEnvMigration) {
      // Already fully migrated
      return { changed: false, state: s };
    }

    // Perform shape-only migration
    const migratedGroups = s.groups.map((g) => {
      const migratedCommands = (g.commands || []).map((cmd) => ({
        ...cmd,
        env: normalizeEnvEntries(cmd.env),
        // Shape-fix: ensure autoStart is always a boolean (default false).
        // Running `pnpm install` at every boot would be wrong, so we never
        // auto-apply autoStart during migration — just guarantee the field exists.
        autoStart: typeof cmd.autoStart === 'boolean' ? cmd.autoStart : false,
      }));

      const migratedActions = (g.actions || []).map((act) => {
        const envEntries = normalizeEnvEntries(act.env);
        // Migrate useEnvs → inheritGroupEnv.
        // Priority: inheritGroupEnv (already set) > useEnvs (legacy) > false (default)
        let inheritGroupEnv;
        if (typeof act.inheritGroupEnv === 'boolean') {
          inheritGroupEnv = act.inheritGroupEnv;
        } else if (typeof act.useEnvs === 'boolean') {
          inheritGroupEnv = act.useEnvs;
        } else {
          inheritGroupEnv = false;
        }
        // Strip legacy useEnvs field from the migrated object
        const { useEnvs: _dropped, ...rest } = act;
        return { ...rest, env: envEntries, inheritGroupEnv };
      });

      return {
        ...g,
        env: Array.isArray(g.env) ? g.env : [],
        commands: migratedCommands,
        actions: migratedActions,
      };
    });

    return {
      changed: true,
      state: {
        ...s,
        groups: migratedGroups,
        services: regenerateLegacyServices(migratedGroups),
      },
    };
  }

  // Fresh install on v3 (no groups at all, no legacy services)
  if (
    s.version === 3 &&
    Array.isArray(s.groups) &&
    s.groups.length === 0 &&
    (!Array.isArray(s.services) || s.services.length === 0)
  ) {
    return { changed: false, state: s };
  }

  const v1Services = Array.isArray(s.services) ? s.services : [];

  // Build insertion-ordered buckets
  const buckets = new Map(); // expanded key → { groupPath, services[] }
  const order = [];

  for (const svc of v1Services) {
    const groupPath = bucketKeyFor(svc);
    if (!buckets.has(groupPath)) {
      buckets.set(groupPath, { groupPath, services: [] });
      order.push(groupPath);
    }
    buckets.get(groupPath).services.push(svc);
  }

  const groups = order.map((key, idx) => {
    const bucket = buckets.get(key);
    // Derive group name from last path segment; fallback to 'Servicios'
    const baseName = key ? (path.basename(key) || 'Servicios') : '(no path)';

    return normalizeGroup({
      id: uuidv4(),
      name: baseName,
      icon: '📦',
      path: bucket.groupPath, // expanded path stored as group path
      mode: 'multi',
      order: idx,
      silenceWarnings: false,
      silenceErrors: false,
      commands: bucket.services.map((svc) => {
        const expandedCwd = expandTilde((svc.cwd || '').trim());
        const cwdOverride =
          expandedCwd && expandedCwd !== bucket.groupPath ? svc.cwd : null;
        return normalizeCommand({
          id: svc.id, // PRESERVE original id for log/state continuity
          name: svc.name,
          icon: null,
          command: svc.command,
          args: svc.args,
          env: svc.env,
          cwd: cwdOverride,
          warnRegex: svc.warnRegex,
          errorRegex: svc.errorRegex,
          silenceWarnings: svc.silenceWarnings,
          silenceErrors: svc.silenceErrors,
          silencedPatterns: svc.silencedPatterns,
        });
      }),
      actions: [],
    });
  });

  const newState = {
    ...s,
    version: 3,
    groups,
    // Only write backup once — don't overwrite an existing backup
    _services_pre_v3_backup: Array.isArray(s._services_pre_v3_backup)
      ? s._services_pre_v3_backup
      : v1Services.slice(),
    services: regenerateLegacyServices(groups),
  };

  return { changed: true, state: newState };
}

// ─────────────────────── Legacy regenerator ─────────────────────

/**
 * Flatten groups back into a legacy services array.
 * Called on every save for dual-write backward-compat.
 * Actions are NOT included (no v1 equivalent).
 */
function regenerateLegacyServices(groups) {
  const services = [];
  for (const group of groups || []) {
    for (const cmd of group.commands || []) {
      services.push({
        id: cmd.id,
        name: cmd.name,
        cwd: cmd.cwd || group.path,
        command: cmd.command,
        args: cmd.args || [],
        env: materializeEnv(cmd.env),
        gitRepo: group.path,
        warnRegex: cmd.warnRegex || DEFAULT_WARN_REGEX,
        errorRegex: cmd.errorRegex || DEFAULT_ERROR_REGEX,
        silenceWarnings: !!(group.silenceWarnings || cmd.silenceWarnings),
        silenceErrors: !!(group.silenceErrors || cmd.silenceErrors),
        silencedPatterns: cmd.silencedPatterns || { warn: [], error: [] },
      });
    }
  }
  return services;
}

// ─────────────────────── Auto-start enforcement ─────────────────────────

/**
 * Enforce auto-start invariants for a group.
 *
 * Multi mode: any subset of commands may have autoStart:true — no change.
 * Single mode: at most ONE command may have autoStart:true.
 *   - If >1 commands have autoStart:true (can happen after a mode switch from
 *     multi → single), ALL are cleared to false.
 *     Safe default: "desactivar todos" avoids surprising the user by arbitrarily
 *     picking a winner.
 *   - If 0 or 1 commands have autoStart:true → unchanged.
 *
 * Returns { group, changed: boolean }.
 * The returned `group` is a shallow clone only when a change occurred.
 */
function enforceSingleModeAutoStart(group) {
  if (!group || group.mode !== 'single') {
    return { group, changed: false };
  }
  const commands = group.commands || [];
  const flaggedCount = commands.filter((c) => c.autoStart === true).length;
  if (flaggedCount <= 1) {
    return { group, changed: false };
  }
  // More than one flagged in single mode → clear all
  const clearedCommands = commands.map((c) =>
    c.autoStart ? { ...c, autoStart: false } : c
  );
  return {
    group: { ...group, commands: clearedCommands },
    changed: true,
  };
}

// ─────────────────────── Validation ─────────────────────────────

/**
 * Validate a group shape for save-time constraints.
 * Returns { valid: boolean, errors: string[] }
 */
function validateGroupShape(group) {
  const errors = [];
  if (!group) {
    errors.push('Group is null or undefined');
    return { valid: false, errors };
  }
  if (!group.path || !group.path.trim()) {
    errors.push('Group path must not be empty');
  }
  if (!group.name || !group.name.trim()) {
    errors.push('Group name must not be empty');
  }
  if (group.mode !== 'single' && group.mode !== 'multi') {
    errors.push('Group mode must be "single" or "multi"');
  }
  if (group.preSteps !== undefined) {
    if (!Array.isArray(group.preSteps)) {
      errors.push('preSteps must be an array');
    } else {
      for (let si = 0; si < group.preSteps.length; si++) {
        const step = group.preSteps[si];
        if (!step || typeof step !== 'object') {
          errors.push(`preSteps[${si}] must be an object`);
          continue;
        }
        if (!step.id) errors.push(`preSteps[${si}] missing id`);
        if (step.mode !== 'parallel' && step.mode !== 'serial') {
          errors.push(`preSteps[${si}] mode must be "parallel" or "serial"`);
        }
        if (!Array.isArray(step.scripts)) {
          errors.push(`preSteps[${si}] scripts must be an array`);
        } else {
          for (let sci = 0; sci < step.scripts.length; sci++) {
            const sc = step.scripts[sci];
            if (!sc || typeof sc !== 'object') {
              errors.push(`preSteps[${si}].scripts[${sci}] must be an object`);
              continue;
            }
            if (!sc.id) errors.push(`preSteps[${si}].scripts[${sci}] missing id`);
            if (!sc.name) errors.push(`preSteps[${si}].scripts[${sci}] missing name`);
            if (sc.command === undefined || sc.command === null) {
              errors.push(`preSteps[${si}].scripts[${sci}] missing command`);
            }
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  normalizeGroup,
  normalizeCommand,
  normalizeAction,
  normalizePreScript,
  normalizePreStep,
  normalizeEnvEntries,
  materializeEnv,
  bucketKeyFor,
  migrateServicesToGroups,
  regenerateLegacyServices,
  validateGroupShape,
  enforceSingleModeAutoStart,
  clampMaxLogLinesOrNull,
  DEFAULT_WARN_REGEX,
  DEFAULT_ERROR_REGEX,
};
