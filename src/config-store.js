'use strict';

const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');
const {
  normalizeGroup,
  normalizeCommand,
  normalizeAction,
  migrateServicesToGroups,
  regenerateLegacyServices,
  enforceSingleModeAutoStart,
  DEFAULT_WARN_REGEX,
  DEFAULT_ERROR_REGEX,
} = require('./groups-model');

const DEFAULT_GLOBAL_SETTINGS = {
  autostart: false,
  silenceWarnings: false,
  silenceErrors: false,
};

const schema = {
  version: { type: 'number', default: 3 },
  services: { type: 'array', default: [] },                     // legacy mirror, dual-write
  groups: { type: 'array', default: [] },                       // canonical
  globalSettings: { type: 'object', default: DEFAULT_GLOBAL_SETTINGS },
  _services_pre_v3_backup: { type: 'array', default: [] },      // written once on migration
};

const store = new Store({ name: 'config', schema });

// ─────────────────────── Boot migration ──────────────────────────────
(function runMigration() {
  const raw = store.store;
  const result = migrateServicesToGroups(raw);
  if (result.changed) {
    // Atomic write of all fields at once
    store.set('version', result.state.version);
    store.set('groups', result.state.groups);
    store.set('services', result.state.services);
    store.set('_services_pre_v3_backup', result.state._services_pre_v3_backup);
  }
})();

// ─────────────────────── Internal helpers ────────────────────────────

function _getGroups() {
  return store.get('groups', []);
}

/** Write groups + regenerate legacy services in one operation. */
function _persistGroups(groups) {
  store.set('groups', groups);
  store.set('services', regenerateLegacyServices(groups));
}

// ─────────────────────── Group CRUD ──────────────────────────────────

function listGroups() {
  return _getGroups();
}

function getGroup(id) {
  return _getGroups().find((g) => g.id === id) || null;
}

function saveGroup(groupData) {
  const groups = _getGroups();
  let normalized = normalizeGroup(groupData);
  // Enforce single-mode auto-start invariant: if the group is in single mode
  // and more than one command has autoStart:true (can happen after a multi→single
  // mode switch), clear all of them. Returns { group, changed }.
  const enforced = enforceSingleModeAutoStart(normalized);
  normalized = enforced.group;
  const idx = groups.findIndex((g) => g.id === normalized.id);
  if (idx >= 0) {
    groups[idx] = normalized;
  } else {
    normalized.order = groups.length;
    groups.push(normalized);
  }
  _persistGroups(groups);
  return { ...normalized, _autoStartEnforced: enforced.changed };
}

function deleteGroup(id) {
  const groups = _getGroups().filter((g) => g.id !== id);
  _persistGroups(groups);
}

function reorderGroups(orderedIds) {
  if (!Array.isArray(orderedIds)) return _getGroups();
  const current = _getGroups();
  const byId = new Map(current.map((g) => [g.id, g]));
  const seen = new Set();
  const sorted = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) {
      sorted.push({ ...byId.get(id), order: sorted.length });
      seen.add(id);
    }
  }
  for (const g of current) {
    if (!seen.has(g.id)) sorted.push({ ...g, order: sorted.length });
  }
  _persistGroups(sorted);
  return sorted;
}

// ─────────────────────── Command CRUD ────────────────────────────────

function saveCommand(groupId, commandData) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return null;
  const group = groups[gIdx];
  const normalized = normalizeCommand(commandData);
  const cIdx = group.commands.findIndex((c) => c.id === normalized.id);
  if (cIdx >= 0) {
    group.commands[cIdx] = normalized;
  } else {
    group.commands.push(normalized);
  }
  _persistGroups(groups);
  return normalized;
}

function deleteCommand(groupId, commandId) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return;
  groups[gIdx].commands = groups[gIdx].commands.filter((c) => c.id !== commandId);
  _persistGroups(groups);
}

function reorderCommands(groupId, orderedIds) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return;
  const commands = groups[gIdx].commands;
  const byId = new Map(commands.map((c) => [c.id, c]));
  const seen = new Set();
  const sorted = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) { sorted.push(byId.get(id)); seen.add(id); }
  }
  for (const c of commands) { if (!seen.has(c.id)) sorted.push(c); }
  groups[gIdx].commands = sorted;
  _persistGroups(groups);
}

// ─────────────────────── Action CRUD ─────────────────────────────────

function saveAction(groupId, actionData) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return null;
  const group = groups[gIdx];
  const normalized = normalizeAction(actionData);
  const aIdx = group.actions.findIndex((a) => a.id === normalized.id);
  if (aIdx >= 0) {
    group.actions[aIdx] = normalized;
  } else {
    group.actions.push(normalized);
  }
  _persistGroups(groups);
  return normalized;
}

function deleteAction(groupId, actionId) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return;
  groups[gIdx].actions = groups[gIdx].actions.filter((a) => a.id !== actionId);
  _persistGroups(groups);
}

function reorderActions(groupId, orderedIds) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return;
  const actions = groups[gIdx].actions;
  const byId = new Map(actions.map((a) => [a.id, a]));
  const seen = new Set();
  const sorted = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) { sorted.push(byId.get(id)); seen.add(id); }
  }
  for (const a of actions) { if (!seen.has(a.id)) sorted.push(a); }
  groups[gIdx].actions = sorted;
  _persistGroups(groups);
}

// ─────────────────────── Silence helpers ─────────────────────────────

function addSilencedPattern(groupId, commandId, level, pattern) {
  if (level !== 'warn' && level !== 'error') return null;
  const trimmed = String(pattern || '').trim();
  if (!trimmed) return null;
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return null;
  const cIdx = groups[gIdx].commands.findIndex((c) => c.id === commandId);
  if (cIdx < 0) return null;
  const cmd = groups[gIdx].commands[cIdx];
  const sp = cmd.silencedPatterns || { warn: [], error: [] };
  const list = Array.isArray(sp[level]) ? sp[level].slice() : [];
  if (!list.includes(trimmed)) list.push(trimmed);
  groups[gIdx].commands[cIdx] = { ...cmd, silencedPatterns: { ...sp, [level]: list } };
  _persistGroups(groups);
  return groups[gIdx].commands[cIdx];
}

function removeSilencedPattern(groupId, commandId, level, pattern) {
  if (level !== 'warn' && level !== 'error') return null;
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return null;
  const cIdx = groups[gIdx].commands.findIndex((c) => c.id === commandId);
  if (cIdx < 0) return null;
  const cmd = groups[gIdx].commands[cIdx];
  const sp = cmd.silencedPatterns || { warn: [], error: [] };
  const list = (Array.isArray(sp[level]) ? sp[level] : []).filter((p) => p !== pattern);
  groups[gIdx].commands[cIdx] = { ...cmd, silencedPatterns: { ...sp, [level]: list } };
  _persistGroups(groups);
  return groups[gIdx].commands[cIdx];
}

function setCommandSilence(groupId, commandId, level, enabled) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return null;
  const cIdx = groups[gIdx].commands.findIndex((c) => c.id === commandId);
  if (cIdx < 0) return null;
  const key = level === 'warn' ? 'silenceWarnings' : level === 'error' ? 'silenceErrors' : null;
  if (!key) return null;
  groups[gIdx].commands[cIdx] = { ...groups[gIdx].commands[cIdx], [key]: !!enabled };
  _persistGroups(groups);
  return groups[gIdx].commands[cIdx];
}

function setGroupSilence(groupId, level, enabled) {
  const groups = _getGroups();
  const gIdx = groups.findIndex((g) => g.id === groupId);
  if (gIdx < 0) return null;
  const key = level === 'warn' ? 'silenceWarnings' : level === 'error' ? 'silenceErrors' : null;
  if (!key) return null;
  groups[gIdx] = { ...groups[gIdx], [key]: !!enabled };
  _persistGroups(groups);
  return groups[gIdx];
}

// ─────────────────────── Legacy read (for PM resolve) ─────────────────

/**
 * List services is kept for compatibility with the tray-icon aggregateColor
 * caller. Returns the regenerated legacy services array.
 */
function listServices() {
  return store.get('services', []);
}

// ─────────────────────── Global settings ─────────────────────────────

function getGlobalSettings() {
  const stored = store.get('globalSettings', {}) || {};
  return { ...DEFAULT_GLOBAL_SETTINGS, ...stored };
}

function saveGlobalSettings(patch) {
  const next = { ...getGlobalSettings(), ...(patch || {}) };
  next.autostart = !!next.autostart;
  next.silenceWarnings = !!next.silenceWarnings;
  next.silenceErrors = !!next.silenceErrors;
  store.set('globalSettings', next);
  return next;
}

// ─────────────────────── Import / Export ─────────────────────────────────────

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { serializeConfig } = require('./config-io');

/**
 * Build the full export-safe snapshot of the current store.
 * Reads only known keys — never touches services or _services_pre_v3_backup.
 */
function exportConfig() {
  return serializeConfig(
    {
      version: store.get('version', 3),
      groups: store.get('groups', []),
      globalSettings: getGlobalSettings(),
    },
    app ? app.getVersion() : null,
  );
}

/**
 * Atomically replace the entire configuration from an already-validated payload.
 * Calls _persistGroups to regenerate the legacy services[] dual-write.
 *
 * @param {{ version: number, groups: object[], globalSettings: object }} payload
 */
function replaceConfig(payload) {
  store.set('version', payload.version);
  store.set('globalSettings', payload.globalSettings);
  // Defensively enforce single-mode auto-start invariant on all imported groups.
  const safeGroups = (payload.groups || []).map((g) => enforceSingleModeAutoStart(g).group);
  _persistGroups(safeGroups);
}

/**
 * Write a pre-import backup of the current store to userData.
 * Returns the backup file path.
 */
function writeImportBackup() {
  const userData = app.getPath('userData');
  const backupPath = path.join(userData, 'pre-import-backup.json');
  const snapshot = {
    backedUpAt: new Date().toISOString(),
    version: store.get('version', 3),
    groups: store.get('groups', []),
    globalSettings: getGlobalSettings(),
  };
  fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return backupPath;
}

// ─────────────────────── Exports ─────────────────────────────────────

module.exports = {
  // Groups
  listGroups,
  getGroup,
  saveGroup,
  deleteGroup,
  reorderGroups,
  // Commands
  saveCommand,
  deleteCommand,
  reorderCommands,
  // Actions
  saveAction,
  deleteAction,
  reorderActions,
  // Silence
  addSilencedPattern,
  removeSilencedPattern,
  setCommandSilence,
  setGroupSilence,
  // Global settings
  getGlobalSettings,
  saveGlobalSettings,
  // Legacy (used by PM resolution and backward compat)
  listServices,
  DEFAULT_WARN_REGEX,
  DEFAULT_ERROR_REGEX,
  // Import / Export
  exportConfig,
  replaceConfig,
  writeImportBackup,
};
