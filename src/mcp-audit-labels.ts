import type { McpAuditEntry, McpAuditResult } from './ipc-contract/mcp-api.js';

/**
 * What both sides of the «Actividad» log agree on: the words it uses for an
 * outcome — shown by the window, matched by main's search — and how long an
 * entry is kept, which main prunes by and the window's date picker stops at.
 */

/** Entries older than this are pruned from the log. */
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
