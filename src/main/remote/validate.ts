import type { RemoteSettingsView } from '../../ipc-contract/remote-wire.js';

/**
 * Pure narrowing of what a phone sends. Each returns the value it vouches
 * for, or null — never throws — so a malformed request is a plain 400 and
 * nothing past these checks has to distrust its input again.
 */

const ID_MAX = 200;
const BRANCH_MAX = 255;
const DEFAULT_TAIL = 300;
const MAX_TAIL = 1000;
const CONTROL_CHARS = /\p{Cc}/u;
/**
 * Characters git refuses in a ref name, plus whitespace. A leading dash is
 * refused too: git would read the name as an option.
 */
const BRANCH_FORBIDDEN = /[\s~^:?*[\\]|\.\./u;
const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'autostart',
  'notifySuccess',
  'silenceWarnings',
  'silenceErrors',
] satisfies (keyof RemoteSettingsView)[]);

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty printable string of at most 200 characters. */
export function idField(body: unknown, key: string): string | null {
  const value = record(body)?.[key];
  if (typeof value !== 'string' || value === '' || value.length > ID_MAX)
    return null;
  return CONTROL_CHARS.test(value) ? null : value;
}

export function decisionField(body: unknown): 'confirm' | 'cancel' | null {
  const value = record(body)?.decision;
  return value === 'confirm' || value === 'cancel' ? value : null;
}

/** `?tail=`: 300 when absent, at most 1000, a positive integer otherwise. */
export function tailParam(raw: string | null): number | null {
  if (raw === null) return DEFAULT_TAIL;
  if (!/^\d+$/.test(raw)) return null;
  const tail = Number(raw);
  return tail < 1 ? null : Math.min(tail, MAX_TAIL);
}

/** At least one whitelisted switch, every value a boolean, nothing else. */
export function settingsPatch(
  body: unknown,
): Partial<RemoteSettingsView> | null {
  const raw = record(body);
  if (!raw) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0) return null;
  const patch: Partial<RemoteSettingsView> = {};
  for (const [key, value] of entries) {
    if (!SETTINGS_KEYS.has(key) || typeof value !== 'boolean') return null;
    patch[key as keyof RemoteSettingsView] = value;
  }
  return patch;
}

export function branchField(body: unknown): string | null {
  const value = record(body)?.branch;
  if (typeof value !== 'string' || value === '' || value.length > BRANCH_MAX)
    return null;
  if (value.startsWith('-') || CONTROL_CHARS.test(value)) return null;
  return BRANCH_FORBIDDEN.test(value) ? null : value;
}
