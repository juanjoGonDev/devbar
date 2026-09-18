import type { IpcMainInvokeEvent } from 'electron';
import type { GlobalSettings } from '../domain-types.js';
import type { ImportPreview, SilenceLevel } from '../ipc-contract.js';

/**
 * Payload validation for every `ipcMain.handle` entry point. A renderer is a
 * separate process whose messages are untrusted input, so each handler
 * narrows its payload here before touching the store or the process manager.
 *
 * Extracted from `main.ts` unchanged: these are pure functions over the raw
 * IPC value, which is what makes them the only part of the IPC surface worth
 * testing on its own.
 */
export type UnknownRecord = Record<string, unknown>;

/**
 * The slice of `ipcMain` the handler modules need. Registering against this
 * instead of the global lets a test collect the handlers and invoke them
 * directly, which is the only way the handler bodies are reachable off
 * Electron.
 */
export interface IpcRegistrar {
  handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => void;
}

/** `confirm` proceeds with the gated start; `cancel` declines it. */
export type ConfirmDecision = 'confirm' | 'cancel';

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function ipcRecord(value: unknown, label = 'payload'): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid IPC ${label}: expected object`);
  }
  return value as UnknownRecord;
}
export function ipcString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`Invalid IPC ${label}: expected string`);
  return value;
}
export function ipcStringField(value: unknown, field: string): string {
  return ipcString(ipcRecord(value)[field], field);
}
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  );
}
export function ipcStringArrayField(value: unknown, field: string): string[] {
  const candidate = ipcRecord(value)[field];
  if (!isStringArray(candidate))
    throw new TypeError(`Invalid IPC ${field}: expected string[]`);
  return candidate;
}

export function ipcBooleanField(value: unknown, field: string): boolean {
  const candidate = ipcRecord(value)[field];
  if (typeof candidate !== 'boolean')
    throw new TypeError(`Invalid IPC ${field}: expected boolean`);
  return candidate;
}
export function ipcNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid IPC ${label}: expected finite number`);
  }
  return value;
}
export function ipcSilenceLevel(value: unknown): SilenceLevel {
  if (value !== 'warn' && value !== 'error')
    throw new TypeError('Invalid IPC silence level');
  return value;
}
export function ipcConfirmDecision(value: unknown): ConfirmDecision {
  if (value !== 'confirm' && value !== 'cancel')
    throw new TypeError('Invalid IPC confirmation decision');
  return value;
}
export function ipcImportPreview(value: unknown): ImportPreview {
  const preview = ipcRecord(value, 'import preview');
  const numberField = (
    field: keyof Pick<
      ImportPreview,
      | 'groupsCount'
      | 'commandsCount'
      | 'actionsCount'
      | 'preStepsCount'
      | 'preScriptsCount'
    >,
  ): number => ipcNumber(preview[field], String(field));
  const hasGlobalSettings = preview.hasGlobalSettings;
  if (typeof hasGlobalSettings !== 'boolean')
    throw new TypeError('Invalid IPC hasGlobalSettings');
  return {
    groupsCount: numberField('groupsCount'),
    commandsCount: numberField('commandsCount'),
    actionsCount: numberField('actionsCount'),
    preStepsCount: numberField('preStepsCount'),
    preScriptsCount: numberField('preScriptsCount'),
    hasGlobalSettings,
  };
}
export function ipcGlobalSettingsPatch(
  value: unknown,
): Partial<GlobalSettings> {
  const raw = ipcRecord(value, 'settings patch');
  const patch: Partial<GlobalSettings> = {};
  for (const field of [
    'autostart',
    'silenceWarnings',
    'silenceErrors',
    'notifySuccess',
    'preScriptsAutoRun',
  ] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== 'boolean')
        throw new TypeError(`Invalid IPC ${field}`);
      patch[field] = raw[field];
    }
  }
  if (raw['theme'] !== undefined) {
    if (
      raw['theme'] !== 'auto' &&
      raw['theme'] !== 'light' &&
      raw['theme'] !== 'dark'
    )
      throw new TypeError('Invalid IPC theme');
    patch['theme'] = raw['theme'];
  }
  for (const field of ['maxLogLines'] as const) {
    if (raw[field] !== undefined) patch[field] = ipcNumber(raw[field], field);
  }
  return patch;
}
