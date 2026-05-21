'use strict';

/**
 * config-io.js — pure, Electron-free module for config import/export.
 *
 * Exports:
 *   serializeConfig(rawStore, appVersion)    → export-shape object
 *   validateImportedConfig(obj)              → { ok, payload } | { ok: false, error }
 *   summarizeImport(payload)                 → { groupsCount, commandsCount, actionsCount, hasGlobalSettings }
 *   EXPORT_SCHEMA_VERSION                    → 3
 */

const { validateGroupShape, normalizeGroup } = require('./groups-model');

const EXPORT_SCHEMA_VERSION = 3;

// ─────────────────────── Serialization ───────────────────────────────────

/**
 * Build the export-safe shape from a raw store snapshot.
 * Reads only known top-level keys — never touches services or _services_pre_v3_backup.
 *
 * @param {{ version?: number, groups?: object[], globalSettings?: object }} rawStore
 * @param {string|null} appVersion
 * @returns {{ exportedAt: string, appVersion: string|null, version: number, groups: object[], globalSettings: object }}
 */
function serializeConfig(rawStore, appVersion) {
  const raw = rawStore || {};
  return {
    exportedAt: new Date().toISOString(),
    appVersion: appVersion || null,
    version: typeof raw.version === 'number' ? raw.version : EXPORT_SCHEMA_VERSION,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    globalSettings: (raw.globalSettings && typeof raw.globalSettings === 'object')
      ? raw.globalSettings
      : {},
  };
}

// ─────────────────────── Validation ──────────────────────────────────────

/**
 * Validate and normalize an imported config object.
 * Unknown top-level keys are silently stripped.
 *
 * @param {unknown} obj
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function validateImportedConfig(obj) {
  // Root must be a plain object
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Root must be a JSON object' };
  }

  // Version must be exactly 3
  if (obj.version !== EXPORT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Versión de schema incompatible (esperada ${EXPORT_SCHEMA_VERSION}, recibida ${obj.version})`,
    };
  }

  // groups must be an array (empty is ok)
  if (!Array.isArray(obj.groups)) {
    return { ok: false, error: 'groups debe ser un array' };
  }

  // Normalize and validate each group
  const cleanGroups = [];
  for (let i = 0; i < obj.groups.length; i++) {
    const rawGroup = obj.groups[i] || {};

    // Pre-validate commands and actions on the RAW input BEFORE normalizeGroup
    // fills in defaults — so we can catch missing required fields.
    const rawCommands = Array.isArray(rawGroup.commands) ? rawGroup.commands : [];
    for (const rawCmd of rawCommands) {
      const rc = rawCmd || {};
      // command is required for commands (not actions); name is required
      if (!rc.command || typeof rc.command !== 'string' || !rc.command.trim()) {
        return {
          ok: false,
          error: `Grupo "${rawGroup.name || `#${i}`}" tiene un comando sin campo command`,
        };
      }
      if (!rc.name || typeof rc.name !== 'string' || !rc.name.trim()) {
        return {
          ok: false,
          error: `Grupo "${rawGroup.name || `#${i}`}" tiene un comando sin name`,
        };
      }
      // env must be an object (legacy) or array (new), not a string/number/etc.
      if (rc.env !== undefined && rc.env !== null) {
        if (typeof rc.env === 'string' || typeof rc.env === 'number' || typeof rc.env === 'boolean') {
          return {
            ok: false,
            error: `Grupo "${rawGroup.name || `#${i}`}" tiene un comando con env inválido (debe ser objeto o array)`,
          };
        }
        if (Array.isArray(rc.env)) {
          for (const entry of rc.env) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              return {
                ok: false,
                error: `Grupo "${rawGroup.name || `#${i}`}" tiene un comando con entradas env inválidas`,
              };
            }
          }
        }
      }
    }

    const rawActions = Array.isArray(rawGroup.actions) ? rawGroup.actions : [];
    for (const rawAct of rawActions) {
      const ra = rawAct || {};
      if (!ra.name || typeof ra.name !== 'string' || !ra.name.trim()) {
        return {
          ok: false,
          error: `Grupo "${rawGroup.name || `#${i}`}" tiene una acción sin name`,
        };
      }
      // env must be an object (legacy) or array (new), not a string/number/etc.
      if (ra.env !== undefined && ra.env !== null) {
        if (typeof ra.env === 'string' || typeof ra.env === 'number' || typeof ra.env === 'boolean') {
          return {
            ok: false,
            error: `Grupo "${rawGroup.name || `#${i}`}" tiene una acción con env inválido (debe ser objeto o array)`,
          };
        }
        if (Array.isArray(ra.env)) {
          for (const entry of ra.env) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              return {
                ok: false,
                error: `Grupo "${rawGroup.name || `#${i}`}" tiene una acción con entradas env inválidas`,
              };
            }
          }
        }
      }
    }

    // Validate group-level env (must be array or absent)
    if (rawGroup.env !== undefined && rawGroup.env !== null) {
      if (!Array.isArray(rawGroup.env)) {
        return {
          ok: false,
          error: `Grupo "${rawGroup.name || `#${i}`}" tiene un env de grupo inválido (debe ser array)`,
        };
      }
      for (const entry of rawGroup.env) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return {
            ok: false,
            error: `Grupo "${rawGroup.name || `#${i}`}" tiene entradas env de grupo inválidas`,
          };
        }
      }
    }

    let g;
    try {
      g = normalizeGroup(rawGroup);
    } catch (err) {
      return { ok: false, error: `Grupo #${i}: ${err.message}` };
    }

    const v = validateGroupShape(g);
    if (!v.valid) {
      return { ok: false, error: `Grupo #${i} "${g.name}": ${v.errors.join(', ')}` };
    }

    cleanGroups.push(g);
  }

  // globalSettings is optional; coerce known booleans, strip unknown keys
  const gs = (obj.globalSettings && typeof obj.globalSettings === 'object' && !Array.isArray(obj.globalSettings))
    ? obj.globalSettings
    : {};

  const cleanGlobalSettings = {
    autostart: !!gs.autostart,
    silenceWarnings: !!gs.silenceWarnings,
    silenceErrors: !!gs.silenceErrors,
  };

  // Return only the known top-level keys (strips exportedAt, appVersion, services, etc.)
  return {
    ok: true,
    payload: {
      version: EXPORT_SCHEMA_VERSION,
      groups: cleanGroups,
      globalSettings: cleanGlobalSettings,
    },
  };
}

// ─────────────────────── Summary ──────────────────────────────────────────

/**
 * Count groups, commands, and actions from a validated payload.
 *
 * @param {{ groups: object[], globalSettings: object }} payload
 * @returns {{ groupsCount: number, commandsCount: number, actionsCount: number, hasGlobalSettings: boolean }}
 */
function summarizeImport(payload) {
  let commandsCount = 0;
  let actionsCount = 0;
  for (const g of payload.groups || []) {
    commandsCount += (g.commands || []).length;
    actionsCount += (g.actions || []).length;
  }
  return {
    groupsCount: (payload.groups || []).length,
    commandsCount,
    actionsCount,
    hasGlobalSettings: !!(payload.globalSettings && typeof payload.globalSettings === 'object'),
  };
}

// ─────────────────────── Exports ──────────────────────────────────────────

module.exports = {
  serializeConfig,
  validateImportedConfig,
  summarizeImport,
  EXPORT_SCHEMA_VERSION,
};
