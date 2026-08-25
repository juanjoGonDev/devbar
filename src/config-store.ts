import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import type {
  Action,
  Command,
  GlobalSettings,
  Group,
  LegacyService,
  PreScript,
  PreStep,
} from './domain-types.js';
import {
  enforceSingleModeAutoStart,
  migrateServicesToGroups,
  normalizeAction,
  normalizeCommand,
  normalizeGroup,
  normalizePreScript,
  normalizePreStep,
  regenerateLegacyServices,
} from './groups-model.js';
import { serializeConfig } from './config-io.js';

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  autostart: false,
  silenceWarnings: false,
  silenceErrors: false,
  maxLogLines: 10_000,
  notifySuccess: true,
  notifyAutoCloseSecs: 5,
};

type StoreState = {
  version: number;
  services: LegacyService[];
  groups: Group[];
  globalSettings: GlobalSettings;
  scheduleState: Record<string, string>;
  _services_pre_v3_backup: unknown[];
};

function clampMaxLogLines(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return 10_000;
  return Math.min(50_000, Math.max(100, Math.floor(numberValue)));
}

function clampNotifyAutoCloseSecs(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return 0;
  return Math.min(3600, Math.floor(numberValue));
}

const schema = {
  version: { type: 'number', default: 3 },
  services: { type: 'array', default: [] },
  groups: { type: 'array', default: [] },
  globalSettings: { type: 'object', default: DEFAULT_GLOBAL_SETTINGS },
  scheduleState: { type: 'object', default: {} },
  _services_pre_v3_backup: { type: 'array', default: [] },
} as const;

const store = new Store<StoreState>({ name: 'config', schema });

function runMigration(): void {
  const result = migrateServicesToGroups(store.store);
  if (!result.changed) return;
  store.set('version', result.state.version);
  store.set('groups', result.state.groups);
  store.set('services', result.state.services);
  if (Array.isArray(result.state._services_pre_v3_backup)) {
    store.set('_services_pre_v3_backup', result.state._services_pre_v3_backup);
  }
}
runMigration();

function getGroupsInternal(): Group[] {
  return store.get('groups', []).map(normalizeGroup);
}
function persistGroups(groups: Group[]): void {
  store.set('groups', groups);
  store.set('services', regenerateLegacyServices(groups));
}

export function listGroups(): Group[] {
  return getGroupsInternal();
}
export function getGroup(id: string): Group | null {
  return getGroupsInternal().find((group) => group.id === id) ?? null;
}
export function saveGroup(
  groupData: unknown,
): Group & { _autoStartEnforced: boolean } {
  const groups = getGroupsInternal();
  const normalized = normalizeGroup(groupData);
  const enforced = enforceSingleModeAutoStart(normalized);
  const safeGroup = enforced.group ?? normalized;
  const index = groups.findIndex((group) => group.id === safeGroup.id);
  if (index >= 0) groups[index] = safeGroup;
  else {
    safeGroup.order = groups.length;
    groups.push(safeGroup);
  }
  persistGroups(groups);
  return { ...safeGroup, _autoStartEnforced: enforced.changed };
}
export function deleteGroup(id: string): void {
  persistGroups(getGroupsInternal().filter((group) => group.id !== id));
}
function reorderByIds<T extends { id: string }>(
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
export function reorderGroups(orderedIds: readonly string[]): Group[] {
  const sorted = reorderByIds(getGroupsInternal(), orderedIds).map(
    (group, index) => ({ ...group, order: index }),
  );
  persistGroups(sorted);
  return sorted;
}

export function saveCommand(
  groupId: string,
  commandData: unknown,
): Command | null {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId);
  if (index < 0) return null;
  const group = groups[index];
  if (!group) return null;
  const normalized = normalizeCommand(commandData),
    commandIndex = group.commands.findIndex(
      (command) => command.id === normalized.id,
    );
  if (commandIndex >= 0) group.commands[commandIndex] = normalized;
  else group.commands.push(normalized);
  persistGroups(groups);
  return normalized;
}
export function deleteCommand(groupId: string, commandId: string): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.commands = group.commands.filter((command) => command.id !== commandId);
  persistGroups(groups);
}
export function reorderCommands(
  groupId: string,
  orderedIds: readonly string[],
): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.commands = reorderByIds(group.commands, orderedIds);
  persistGroups(groups);
}

export function saveAction(
  groupId: string,
  actionData: unknown,
): Action | null {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return null;
  const normalized = normalizeAction(actionData),
    actionIndex = group.actions.findIndex(
      (action) => action.id === normalized.id,
    );
  if (actionIndex >= 0) group.actions[actionIndex] = normalized;
  else group.actions.push(normalized);
  persistGroups(groups);
  return normalized;
}
export function deleteAction(groupId: string, actionId: string): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.actions = group.actions.filter((action) => action.id !== actionId);
  persistGroups(groups);
}
export function reorderActions(
  groupId: string,
  orderedIds: readonly string[],
): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.actions = reorderByIds(group.actions, orderedIds);
  persistGroups(groups);
}

export function savePreStep(groupId: string, data: unknown): PreStep | null {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return null;
  const normalized = normalizePreStep(data),
    stepIndex = group.preSteps.findIndex((step) => step.id === normalized.id);
  if (stepIndex >= 0) group.preSteps[stepIndex] = normalized;
  else group.preSteps.push(normalized);
  persistGroups(groups);
  return normalized;
}
export function deletePreStep(groupId: string, stepId: string): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.preSteps = group.preSteps.filter((step) => step.id !== stepId);
  persistGroups(groups);
}
export function reorderPreSteps(
  groupId: string,
  orderedIds: readonly string[],
): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.preSteps = reorderByIds(group.preSteps, orderedIds);
  persistGroups(groups);
}

export function savePreScript(
  groupId: string,
  stepId: string,
  data: unknown,
): PreScript | null {
  const groups = getGroupsInternal(),
    groupIndex = groups.findIndex((group) => group.id === groupId),
    group = groups[groupIndex];
  if (!group) return null;
  const stepIndex = group.preSteps.findIndex((step) => step.id === stepId),
    step = group.preSteps[stepIndex];
  if (!step) return null;
  const normalized = normalizePreScript(data),
    scriptIndex = step.scripts.findIndex(
      (script) => script.id === normalized.id,
    );
  if (scriptIndex >= 0) step.scripts[scriptIndex] = normalized;
  else step.scripts.push(normalized);
  persistGroups(groups);
  return normalized;
}
export function deletePreScript(
  groupId: string,
  stepId: string,
  scriptId: string,
): void {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId),
    step = group?.preSteps.find((candidate) => candidate.id === stepId);
  if (!group || !step) return;
  step.scripts = step.scripts.filter((script) => script.id !== scriptId);
  persistGroups(groups);
}
export function reorderPreScripts(
  groupId: string,
  stepId: string,
  orderedIds: readonly string[],
): void {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId),
    step = group?.preSteps.find((candidate) => candidate.id === stepId);
  if (!group || !step) return;
  step.scripts = reorderByIds(step.scripts, orderedIds);
  persistGroups(groups);
}

type SilenceLevel = 'warn' | 'error';
export function addSilencedPattern(
  groupId: string,
  commandId: string,
  level: SilenceLevel,
  pattern: string,
): Command | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId),
    command = group?.commands.find((candidate) => candidate.id === commandId);
  if (!group || !command) return null;
  const list = [...command.silencedPatterns[level]];
  if (!list.includes(trimmed)) list.push(trimmed);
  command.silencedPatterns = { ...command.silencedPatterns, [level]: list };
  persistGroups(groups);
  return command;
}
export function removeSilencedPattern(
  groupId: string,
  commandId: string,
  level: SilenceLevel,
  pattern: string,
): Command | null {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId),
    command = group?.commands.find((candidate) => candidate.id === commandId);
  if (!group || !command) return null;
  command.silencedPatterns = {
    ...command.silencedPatterns,
    [level]: command.silencedPatterns[level].filter((item) => item !== pattern),
  };
  persistGroups(groups);
  return command;
}
export function setCommandSilence(
  groupId: string,
  commandId: string,
  level: SilenceLevel,
  enabled: boolean,
): Command | null {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId),
    command = group?.commands.find((candidate) => candidate.id === commandId);
  if (!group || !command) return null;
  if (level === 'warn') command.silenceWarnings = enabled;
  else command.silenceErrors = enabled;
  persistGroups(groups);
  return command;
}
export function setGroupSilence(
  groupId: string,
  level: SilenceLevel,
  enabled: boolean,
): Group | null {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  if (level === 'warn') group.silenceWarnings = enabled;
  else group.silenceErrors = enabled;
  persistGroups(groups);
  return group;
}

export function getGlobalSettings(): GlobalSettings {
  return {
    ...DEFAULT_GLOBAL_SETTINGS,
    ...store.get('globalSettings', DEFAULT_GLOBAL_SETTINGS),
  };
}
export function saveGlobalSettings(
  patch: Partial<GlobalSettings>,
): GlobalSettings {
  const next = { ...getGlobalSettings(), ...patch };
  next.autostart = Boolean(next.autostart);
  next.silenceWarnings = Boolean(next.silenceWarnings);
  next.silenceErrors = Boolean(next.silenceErrors);
  next.maxLogLines = clampMaxLogLines(next.maxLogLines);
  next.notifySuccess = Boolean(next.notifySuccess);
  next.notifyAutoCloseSecs = clampNotifyAutoCloseSecs(next.notifyAutoCloseSecs);
  store.set('globalSettings', next);
  return next;
}
export function getScheduleLastRun(processId: string): string | null {
  return store.get('scheduleState', {})[processId] ?? null;
}
export function setScheduleLastRun(processId: string, iso: string): void {
  const state = { ...store.get('scheduleState', {}) };
  state[processId] = iso;
  store.set('scheduleState', state);
}

export function exportConfig(): ReturnType<typeof serializeConfig> {
  return serializeConfig(
    {
      version: store.get('version', 3),
      groups: getGroupsInternal(),
      globalSettings: getGlobalSettings(),
    },
    app.getVersion(),
  );
}
export function replaceConfig(payload: {
  version: number;
  groups: unknown[];
  globalSettings: Partial<GlobalSettings>;
}): void {
  store.set('version', payload.version);
  store.set('globalSettings', saveGlobalSettings(payload.globalSettings));
  const safeGroups = payload.groups
    .map(normalizeGroup)
    .map((group) => enforceSingleModeAutoStart(group).group ?? group);
  persistGroups(safeGroups);
}
export function writeImportBackup(): string {
  const backupPath = path.join(
    app.getPath('userData'),
    'pre-import-backup.json',
  );
  const snapshot = {
    backedUpAt: new Date().toISOString(),
    version: store.get('version', 3),
    groups: getGroupsInternal(),
    globalSettings: getGlobalSettings(),
  };
  fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return backupPath;
}
