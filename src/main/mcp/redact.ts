import type { EnvEntry, Group } from '../../domain-types.js';

/**
 * Secret masking for what an assistant reads (logs, env, diffs) when its
 * client has «Ocultar secretos» on, and for every diff the audit log keeps.
 * Two passes: the values of every env variable DevBar knows (they are the
 * likeliest secrets to reach a log), then the shapes secrets usually have —
 * bearer tokens, `password=…`, AWS / GitHub / OpenAI-style keys, JWTs and
 * credentials inside URLs.
 *
 * Masking leaves the surrounding text intact, so a log line stays readable:
 * `Authorization: Bearer ••••••`.
 */

export const MASK = '••••••';
/** Shorter env values (`1`, `dev`, `true`) are not secrets worth hiding. */
const MIN_SECRET_LENGTH = 6;

const PATTERNS: readonly [
  RegExp,
  (match: string, ...groups: string[]) => string,
][] = [
  [
    /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
    (_m, kind) => `${kind} ${MASK}`,
  ],
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\s|•)([^\s"'&,;]{3,})/gi,
    (_m, key, sep) => `${key}${sep}${MASK}`,
  ],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, () => MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, () => MASK],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g, () => MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, () => MASK],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    () => MASK,
  ],
  [
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,
    (_m, prefix) => `${prefix}${MASK}@`,
  ],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every env value DevBar holds that is long enough to be a secret. */
export function knownSecrets(groups: readonly Group[]): string[] {
  const values = new Set<string>();
  const add = (env: readonly EnvEntry[]): void => {
    for (const entry of env)
      if (entry.value.length >= MIN_SECRET_LENGTH) values.add(entry.value);
  };
  for (const group of groups) {
    add(group.env);
    for (const command of group.commands) add(command.env);
    for (const action of group.actions) add(action.env);
    for (const script of group.preScripts) add(script.env);
  }
  // Longest first, so a value containing another is masked whole.
  return [...values].sort((a, b) => b.length - a.length);
}

export interface Redactor {
  text(value: string): string;
  /** An env list with every value masked (the keys stay). */
  env(entries: readonly EnvEntry[]): EnvEntry[];
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const known =
    secrets.length > 0
      ? new RegExp(secrets.map(escapeRegExp).join('|'), 'g')
      : null;
  return {
    text: (value) => {
      let out = known ? value.replace(known, MASK) : value;
      for (const [pattern, replace] of PATTERNS)
        out = out.replace(pattern, replace);
      return out;
    },
    env: (entries) =>
      entries.map((entry) => ({
        ...entry,
        value: entry.value ? MASK : '',
      })),
  };
}

/** For a client that reads secrets in the clear. */
export const NO_REDACTION: Redactor = {
  text: (value) => value,
  env: (entries) => entries.map((entry) => ({ ...entry })),
};
