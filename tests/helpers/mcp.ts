/**
 * Fixtures for the «MCP» section of the config window: the state main
 * reports, one client and one audit entry, each with every field filled so a
 * test only states what it is about.
 */
import type {
  McpAuditEntry,
  McpClient,
  McpState,
} from '../../src/ipc-contract/mcp-api.js';
import { openConfigWindow } from './config-window.js';
import type { RendererWindow } from './renderer-dom.js';

export function mcpClient(
  name: string,
  extra: Partial<McpClient> = {},
): McpClient {
  return {
    id: `client-${name}`,
    name,
    kind: 'claude-code',
    status: 'allowed',
    createdAt: new Date(2026, 10, 3, 9, 0).getTime(),
    lastUsedAt: null,
    callsToday: 0,
    scopes: { read: true, control: true, workflows: true, config: false },
    confirm: { control: 'never', workflows: 'first', config: 'always' },
    groups: 'all',
    redactSecrets: true,
    ...extra,
  };
}

export function mcpState(extra: Partial<McpState> = {}): McpState {
  return {
    settings: { enabled: false, transport: 'stdio' },
    clients: [],
    connectCommand: {
      claudeCode: 'claude mcp add devbar -- devbar mcp',
      claudeDesktopJson: '{"mcpServers":{"devbar":{"command":"devbar"}}}',
      cursorJson: '{"mcpServers":{"devbar":{"command":"cursor-devbar"}}}',
      opencodeJson: '{"mcp":{"devbar":{"type":"local"}}}',
      codexToml: '[mcp_servers.devbar]',
      generic: 'ELECTRON_RUN_AS_NODE=1 devbar mcp',
    },
    listening: false,
    error: null,
    ...extra,
  };
}

export function auditEntry(
  id: string,
  extra: Partial<McpAuditEntry> = {},
): McpAuditEntry {
  return {
    id,
    at: new Date(2026, 10, 3, 12, 40, 52).getTime(),
    clientId: 'client-Claude Code',
    clientName: 'Claude Code',
    tool: 'restart',
    target: 'Back › Normal',
    result: 'ok',
    summary: '',
    ...extra,
  };
}

/** The config window with the MCP section's boot read answered. */
export async function openMcp(state: McpState): Promise<RendererWindow> {
  const win = await openConfigWindow();
  await win.settle('getMcpState', state);
  return win;
}

/** What a sighted user reads: the text minus hidden parts and icon glyphs. */
export function visible(node: Element | null): string {
  if (!node) return '';
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll('[hidden], .icon').forEach((part) => part.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}

export function click(target: Element | null): void {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Picks a radio the way a click does: checked, then `change`. */
export function pick(input: HTMLInputElement): void {
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
