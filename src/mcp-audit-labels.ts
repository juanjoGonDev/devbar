import type { McpAuditEntry, McpAuditResult } from './ipc-contract/mcp-api.js';

/**
 * The words the «Actividad» log uses for an outcome. Shared by the window,
 * which shows them, and by main, whose search matches what the user reads.
 */

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
