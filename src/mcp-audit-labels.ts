import type { McpAuditEntry, McpAuditResult } from './ipc-contract/mcp-api.js';

/**
 * What both sides of the «Actividad» log agree on: the words it uses for an
 * outcome — shown by the window, matched by main's search — and how long an
 * entry is kept, which main prunes by and the window's date picker stops at.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many days an entry is kept before it is pruned: the user picks it in
 * «Limpiar» › «Borrado automático» (Settings › MCP › Actividad).
 */
export const AUDIT_RETENTION_DAYS = { default: 30, min: 1, max: 365 } as const;

/** A stored or typed number of days as a whole day count within range. */
export function retentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return AUDIT_RETENTION_DAYS.default;
  return Math.min(
    AUDIT_RETENTION_DAYS.max,
    Math.max(AUDIT_RETENTION_DAYS.min, Math.floor(value)),
  );
}

export const AUDIT_RESULT_LABELS: Readonly<Record<McpAuditResult, string>> = {
  ok: 'Correcto',
  warning: 'Con avisos',
  error: 'Error',
  rejected: 'Rechazado',
  pending: 'Pendiente',
};

/** A change that went through reads «Aplicado»; anything else by result. */
export function auditResultLabel(
  entry: Pick<McpAuditEntry, 'result' | 'diff'>,
): string {
  if (entry.result === 'ok' && entry.diff) return 'Aplicado';
  return AUDIT_RESULT_LABELS[entry.result];
}
