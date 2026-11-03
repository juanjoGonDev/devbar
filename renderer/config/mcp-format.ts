import type {
  McpClient,
  McpClientKind,
  McpConnectCommands,
  McpState,
} from '../../src/ipc-contract/mcp-api.js';

/**
 * The words of the «MCP» section that come out of its data: the status line
 * of the server card and the ready-to-paste block for each assistant.
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
