import type {
  McpAuditEntry,
  McpAuditResult,
  McpClient,
  McpClientKind,
  McpConnectCommands,
  McpScopes,
  McpState,
} from '../../src/ipc-contract/mcp-api.js';
import { lastSeen } from './remote-format.js';

/**
 * The words of the «MCP» section that come out of its data: the status line
 * of the server card, the ready-to-paste block for each assistant, the
 * lines that say when a client connected and was last used, and the time and
 * result columns of the activity log.
 */

export interface ConnectSnippet {
  code: string;
  hint: string;
}

/** A JSON block, indented the way a config file reads; anything else as is. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function connectSnippet(
  commands: McpConnectCommands,
  kind: McpClientKind,
): ConnectSnippet {
  switch (kind) {
    case 'claude-code':
      return {
        code: commands.claudeCode,
        hint: 'Pégalo en una terminal. Su primer uso aparece abajo para darle permisos.',
      };
    case 'claude-desktop':
      return {
        code: prettyJson(commands.claudeDesktopJson),
        hint: 'Añádelo a claude_desktop_config.json y reinicia Claude Desktop.',
      };
    case 'cursor':
      return {
        code: prettyJson(commands.cursorJson),
        hint: 'Añádelo a ~/.cursor/mcp.json.',
      };
    case 'opencode':
      return {
        code: prettyJson(commands.opencodeJson),
        hint: 'Añádelo a opencode.json, o a ~/.config/opencode/opencode.json para todos tus proyectos.',
      };
    case 'codex':
      return {
        code: commands.codexToml,
        hint: 'Añádelo a ~/.codex/config.toml y reinicia Codex.',
      };
    case 'other':
      return {
        code: commands.generic,
        hint: 'Para cualquier cliente MCP por stdio.',
      };
  }
}

export interface ServerStatus {
  text: string;
  tone: 'on' | 'off' | 'error';
}

export function serverStatus(state: McpState): ServerStatus {
  if (state.error) return { text: 'Error', tone: 'error' };
  if (!state.listening) return { text: 'Detenido', tone: 'off' };
  const allowed = state.clients.filter(
    (client: McpClient) => client.status === 'allowed',
  ).length;
  return {
    text: `Activo · ${allowed} cliente${allowed === 1 ? '' : 's'}`,
    tone: 'on',
  };
}

/** The four scope families, in the order every list shows them. */
export const SCOPE_KEYS: readonly (keyof McpScopes)[] = [
  'read',
  'control',
  'workflows',
  'config',
];

export const SCOPE_LABELS: Readonly<Record<keyof McpScopes, string>> = {
  read: 'Lectura',
  control: 'Control',
  workflows: 'Workflows',
  config: 'Configuración',
};

const SHORT_DATE = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
});

/** The letter of a client's avatar. */
export function clientInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** «Último uso: hace 3 min · 128 llamadas hoy», or that it never ran. */
export function usageLine(client: McpClient, now: number): string {
  if (client.lastUsedAt === null) return 'Sin usar todavía';
  const used = `Último uso: ${lastSeen(client.lastUsedAt, now)}`;
  const calls = client.callsToday;
  if (calls === 0) return used;
  return `${used} · ${calls} llamada${calls === 1 ? '' : 's'} hoy`;
}

/** «Quiere conectarse · hace 1 min», for a client still waiting. */
export function pendingLine(client: McpClient, now: number): string {
  return `Quiere conectarse · ${lastSeen(client.createdAt, now)}`;
}

const CLOCK = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** «12:41:07», the time column of the activity log. */
export function auditTime(at: number): string {
  return CLOCK.format(at);
}

const RESULT_LABELS: Readonly<Record<McpAuditResult, string>> = {
  ok: 'Correcto',
  warning: 'Con avisos',
  error: 'Error',
  rejected: 'Rechazado',
  pending: 'Pendiente',
};

/** A change that went through reads «Aplicado»; anything else by result. */
export function auditResultLabel(entry: McpAuditEntry): string {
  if (entry.result === 'ok' && entry.diff) return 'Aplicado';
  return RESULT_LABELS[entry.result];
}

/** The «CONEXIÓN» line of the sheet. */
export function connectionLine(client: McpClient, now: number): string {
  const parts = [
    'Local (stdio)',
    `vinculado el ${SHORT_DATE.format(client.createdAt)}`,
  ];
  if (client.lastUsedAt !== null)
    parts.push(`último uso ${lastSeen(client.lastUsedAt, now)}`);
  return parts.join(' · ');
}
