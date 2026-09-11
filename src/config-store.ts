import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import { DEFAULT_MAX_LOG_LINES } from './domain-types.js';
import type {
  Action,
  Command,
  GlobalSettings,
  Group,
  LegacyService,
  PreScript,
  PreStep,
  PreStepScriptRef,
} from './domain-types.js';
import {
  enforceSingleModeAutoStart,
  normalizeAction,
  normalizeCommand,
  normalizeGroup,
  normalizePreScript,
  normalizePreStep,
  planStoreMigration,
  prunePipelineRefs,
  reorderByIds,
  regenerateLegacyServices,
  assignScriptToStep as assignRefToStep,
  unassignScriptFromStep as unassignRefFromStep,
} from './groups-model.js';
import { serializeConfig } from './config-io.js';

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  autostart: false,
  silenceWarnings: false,
  silenceErrors: false,
  maxLogLines: DEFAULT_MAX_LOG_LINES,
  notifySuccess: true,
  preScriptsAutoRun: false,
};

type StoreState = {
  version: number;
  services: LegacyService[];
  groups: Group[];
  preSteps: PreStep[];
  globalSettings: GlobalSettings;
  scheduleState: Record<string, string>;
  _services_pre_v3_backup: unknown[];
};

function clampMaxLogLines(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0)
    return DEFAULT_MAX_LOG_LINES;
  return Math.min(50_000, Math.max(100, Math.floor(numberValue)));
}

const schema = {
  version: { type: 'number', default: 4 },
  services: { type: 'array', default: [] },
  groups: { type: 'array', default: [] },
  preSteps: { type: 'array', default: [] },
  globalSettings: { type: 'object', default: DEFAULT_GLOBAL_SETTINGS },
  scheduleState: { type: 'object', default: {} },
  _services_pre_v3_backup: { type: 'array', default: [] },
} as const;

const store = new Store<StoreState>({ name: 'config', schema });

function runMigration(): void {
  // The whole decision — pipeline hoisting (seeing the PRISTINE raw group
  // before normalizeGroup can strip its legacy keys), THEN the v1/v2->v3
  // conversion or v3/v4 id-repair canonical pass, and the version label
  // itself — lives in the pure, unit-tested `planStoreMigration` (see
  // `tests/groups-model.test.ts`). This function is only the store-write
  // side effect.
  const plan = planStoreMigration(store.store);
  if (!plan.changed) return;
  store.set('version', plan.version);
  store.set('groups', plan.groups);
  store.set('services', plan.services);
  store.set('preSteps', plan.preSteps);
  if (plan.preScriptsAutoRun !== null) {
    store.set('globalSettings', {
      ...getGlobalSettings(),
      preScriptsAutoRun: plan.preScriptsAutoRun,
    });
  }
  if (plan.servicesBackup !== null) {
    store.set('_services_pre_v3_backup', plan.servicesBackup);
  }
}
runMigration();

function getGroupsInternal(): Group[] {
  return store.get('groups', []).map(normalizeGroup);
}
function getPreStepsInternal(): PreStep[] {
  return store.get('preSteps', []).map(normalizePreStep);
}
/**
 * Successor to the old `persistGroups`: writes `groups`, regenerates
 * `services`, and re-derives `preSteps` through `prunePipelineRefs` against
 * the NEW `groups` on every write (D5) — the same "recompute a derived
 * artifact from groups[] on every persist" template as `services` itself,
 * so every current and future write path gets referential-integrity
 * pruning for free instead of a bolt-on prune at each delete call site.
 */
function persistState(groups: Group[], steps?: readonly PreStep[]): void {
  const prunedSteps = prunePipelineRefs(steps ?? getPreStepsInternal(), groups);
  store.set('groups', groups);
  store.set('services', regenerateLegacyServices(groups));
  store.set('preSteps', prunedSteps);
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
  persistState(groups);
  return { ...safeGroup, _autoStartEnforced: enforced.changed };
}
export function deleteGroup(id: string): void {
  persistState(getGroupsInternal().filter((group) => group.id !== id));
}
export function reorderGroups(orderedIds: readonly string[]): Group[] {
  const sorted = reorderByIds(getGroupsInternal(), orderedIds).map(
    (group, index) => ({ ...group, order: index }),
  );
  persistState(sorted);
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
  persistState(groups);
  return normalized;
}
export function deleteCommand(groupId: string, commandId: string): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.commands = group.commands.filter((command) => command.id !== commandId);
  persistState(groups);
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
  persistState(groups);
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
  persistState(groups);
  return normalized;
}
export function deleteAction(groupId: string, actionId: string): void {
  const groups = getGroupsInternal(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.actions = group.actions.filter((action) => action.id !== actionId);
  persistState(groups);
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
  persistState(groups);
}

// Pipeline steps are now a GLOBAL, top-level slice — no `groupId`, since a
// step can hold refs into more than one group's scripts.
export function getPreSteps(): PreStep[] {
  return getPreStepsInternal();
}
export function savePreStep(data: unknown): PreStep {
  const steps = getPreStepsInternal();
  const normalized = normalizePreStep(data);
  const index = steps.findIndex((step) => step.id === normalized.id);
  if (index >= 0) steps[index] = normalized;
  else steps.push(normalized);
  persistState(getGroupsInternal(), steps);
  return normalized;
}
export function deletePreStep(stepId: string): void {
  const steps = getPreStepsInternal().filter((step) => step.id !== stepId);
  persistState(getGroupsInternal(), steps);
}
export function reorderPreSteps(orderedIds: readonly string[]): PreStep[] {
  const sorted = reorderByIds(getPreStepsInternal(), orderedIds);
  persistState(getGroupsInternal(), sorted);
  return sorted;
}

// Script DEFINITIONS stay per-group (cwd/env come from their own group) but
// are now a flat `group.preScripts` list — no `stepId`, since placement into
// the pipeline is a separate concern (assignScriptToStep/unassignScriptFromStep
// below).
export function savePreScript(
  groupId: string,
  data: unknown,
): PreScript | null {
  const groups = getGroupsInternal(),
    groupIndex = groups.findIndex((group) => group.id === groupId),
    group = groups[groupIndex];
  if (!group) return null;
  const normalized = normalizePreScript(data),
    scriptIndex = group.preScripts.findIndex(
      (script) => script.id === normalized.id,
    );
  if (scriptIndex >= 0) group.preScripts[scriptIndex] = normalized;
  else group.preScripts.push(normalized);
  persistState(groups);
  return normalized;
}
export function deletePreScript(groupId: string, scriptId: string): void {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  // persistState prunes any now-dangling pipeline ref to this script (D5).
  group.preScripts = group.preScripts.filter(
    (script) => script.id !== scriptId,
  );
  persistState(groups);
}
export function reorderPreScripts(
  groupId: string,
  orderedIds: readonly string[],
): void {
  const groups = getGroupsInternal(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  group.preScripts = reorderByIds(group.preScripts, orderedIds);
  persistState(groups);
}

// Placement of an already-defined script into (or out of) a global step.
export function assignScriptToStep(
  stepId: string,
  groupId: string,
  scriptId: string,
  position?: number,
): PreStep[] {
  const ref: PreStepScriptRef = { groupId, scriptId };
  const steps = assignRefToStep(getPreStepsInternal(), stepId, ref, position);
  persistState(getGroupsInternal(), steps);
  return steps;
}
export function unassignScriptFromStep(
  stepId: string,
  groupId: string,
  scriptId: string,
): PreStep[] {
  const ref: PreStepScriptRef = { groupId, scriptId };
  const steps = unassignRefFromStep(getPreStepsInternal(), stepId, ref);
  persistState(getGroupsInternal(), steps);
  return steps;
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
  persistState(groups);
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
  persistState(groups);
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
  persistState(groups);
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
  persistState(groups);
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
  next.preScriptsAutoRun = Boolean(next.preScriptsAutoRun);
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
      version: store.get('version', 4),
      groups: getGroupsInternal(),
      preSteps: getPreStepsInternal(),
      globalSettings: getGlobalSettings(),
    },
    app.getVersion(),
  );
}
export function replaceConfig(payload: {
  version: number;
  groups: unknown[];
  preSteps?: unknown[];
  globalSettings: Partial<GlobalSettings>;
}): void {
  store.set('version', payload.version);
  store.set('globalSettings', saveGlobalSettings(payload.globalSettings));
  const safeGroups = payload.groups
    .map(normalizeGroup)
    .map((group) => enforceSingleModeAutoStart(group).group ?? group);
  const safeSteps = Array.isArray(payload.preSteps)
    ? payload.preSteps.map(normalizePreStep)
    : [];
  persistState(safeGroups, safeSteps);
}
export function writeImportBackup(): string {
  const backupPath = path.join(
    app.getPath('userData'),
    'pre-import-backup.json',
  );
  const snapshot = {
    backedUpAt: new Date().toISOString(),
    version: store.get('version', 4),
    groups: getGroupsInternal(),
    preSteps: getPreStepsInternal(),
    globalSettings: getGlobalSettings(),
  };
  fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return backupPath;
}
