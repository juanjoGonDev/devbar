import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Action, Command, GlobalSettings, Group } from './domain-types.js';
import {
  enforceSingleModeAutoStart,
  normalizeAction,
  normalizeCommand,
  normalizeGroup,
  normalizePreStep,
  reorderByIds,
} from './groups-model.js';
import { serializeConfig } from './config-io.js';
import { mergeCustomIcons, referencedCustomIconIds } from './custom-icons.js';
import type { CustomIcon } from './domain-types.js';
import {
  getGlobalSettings,
  readCustomIcons,
  writeCustomIcons,
  persistState,
  groupsOverlayActive,
  readStoredGroups,
  readStoredPreSteps,
  readGroups,
  readVersion,
  saveGlobalSettings,
  storeDirectory,
  writeVersion,
} from './config-store/store.js';

/**
 * Groups and everything nested inside one (commands, actions, silencing),
 * plus whole-config import/export. The store handle, the settings/schedule
 * slices and the migration live in `config-store/store.ts`; the pre-script
 * pipeline lives in `config-store/pipeline-store.ts`. Both are re-exported
 * here so `config-store.js` stays the single import surface for main.
 */

export {
  getGlobalSettings,
  getRemoteControl,
  getScheduleLastRun,
  getTrayPopover,
  groupsOverlayActive,
  setGroupsOverlay,
  saveGlobalSettings,
  saveRemoteControl,
  saveTrayPopover,
  setScheduleLastRun,
} from './config-store/store.js';
export {
  assignScriptToStep,
  deletePreScript,
  deletePreStep,
  getPreSteps,
  reorderPreScripts,
  reorderPreSteps,
  savePreScript,
  savePreStep,
  unassignScriptFromStep,
} from './config-store/pipeline-store.js';
export {
  addCustomIcon,
  deleteCustomIcon,
  listCustomIcons,
} from './config-store/custom-icons-store.js';

/** Why an import is refused while the dev panel's test groups are shown. */
const OVERLAY_IMPORT_REFUSAL =
  'Modo grupos de prueba activo: quita los grupos de prueba en el panel Dev antes de importar.';

export function listGroups(): Group[] {
  return readGroups();
}
export function getGroup(id: string): Group | null {
  return readGroups().find((group) => group.id === id) ?? null;
}
export function saveGroup(
  groupData: unknown,
): Group & { _autoStartEnforced: boolean } {
  const groups = readGroups();
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
  persistState(readGroups().filter((group) => group.id !== id));
}
export function reorderGroups(orderedIds: readonly string[]): Group[] {
  const sorted = reorderByIds(readGroups(), orderedIds).map((group, index) => ({
    ...group,
    order: index,
  }));
  persistState(sorted);
  return sorted;
}

export function saveCommand(
  groupId: string,
  commandData: unknown,
): Command | null {
  const groups = readGroups(),
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
  const groups = readGroups(),
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
  const groups = readGroups(),
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
  const groups = readGroups(),
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
  const groups = readGroups(),
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
  const groups = readGroups(),
    index = groups.findIndex((group) => group.id === groupId),
    group = groups[index];
  if (!group) return;
  group.actions = reorderByIds(group.actions, orderedIds);
  persistState(groups);
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
  const groups = readGroups(),
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
  const groups = readGroups(),
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
  const groups = readGroups(),
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
  const groups = readGroups(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  if (level === 'warn') group.silenceWarnings = enabled;
  else group.silenceErrors = enabled;
  persistState(groups);
  return group;
}

export function exportConfig(): ReturnType<typeof serializeConfig> {
  // The stored groups even while the dev overlay is on: an export is the
  // user's configuration, and test groups have no business in it.
  const groups = readStoredGroups();
  // Only the images the exported configuration uses travel with it.
  const referenced = referencedCustomIconIds(groups);
  return serializeConfig(
    {
      version: readVersion(),
      groups,
      preSteps: readStoredPreSteps(),
      globalSettings: getGlobalSettings(),
      customIcons: readCustomIcons().filter((icon) => referenced.has(icon.id)),
    },
    app.getVersion(),
  );
}
export function replaceConfig(payload: {
  version: number;
  groups: unknown[];
  preSteps?: unknown[];
  globalSettings: Partial<GlobalSettings>;
  customIcons?: readonly CustomIcon[];
}): void {
  if (groupsOverlayActive()) throw new Error(OVERLAY_IMPORT_REFUSAL);
  writeVersion(payload.version);
  // Added to the library, never replacing it: an import overwrites the
  // configuration, but the uploads it does not use are still the user's.
  if (payload.customIcons?.length)
    writeCustomIcons(mergeCustomIcons(readCustomIcons(), payload.customIcons));
  saveGlobalSettings(payload.globalSettings);
  const safeGroups = payload.groups
    .map(normalizeGroup)
    .map((group) => enforceSingleModeAutoStart(group).group ?? group);
  const safeSteps = Array.isArray(payload.preSteps)
    ? payload.preSteps.map(normalizePreStep)
    : [];
  persistState(safeGroups, safeSteps);
}
export function writeImportBackup(): string {
  const backupPath = path.join(storeDirectory(), 'pre-import-backup.json');
  const snapshot = {
    backedUpAt: new Date().toISOString(),
    version: readVersion(),
    groups: readStoredGroups(),
    preSteps: readStoredPreSteps(),
    globalSettings: getGlobalSettings(),
    customIcons: readCustomIcons(),
  };
  fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return backupPath;
}
