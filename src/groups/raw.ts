/**
 * Coercion helpers shared by every pass over a RAW store/import snapshot.
 *
 * Nothing here knows about the domain shapes: these answer "what is this
 * untyped value, really?" for JSON that may come from a hand-edited file, a
 * third-party export, or a pre-TypeScript version of the app.
 */
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_WARN_REGEX = '\\bwarn(ing)?s?\\b';
export const DEFAULT_ERROR_REGEX = '\\berror(s)?\\b';

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function stringArray(value: unknown): string[] {
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

export function expandTilde(value: string): string {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}
