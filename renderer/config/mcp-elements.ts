import { byId } from '../dom.js';

/**
 * Every element of the «MCP» section, resolved in one place: config.ts calls
 * this once, and tests/renderer-dom-contract.test.ts checks each assertion
 * against config.html.
 */

interface McpServerElements {
  enabled: HTMLInputElement;
  status: HTMLElement;
  error: HTMLElement;
}

interface McpConnectElements {
  kinds: HTMLElement;
  code: HTMLPreElement;
  copy: HTMLButtonElement;
  hint: HTMLElement;
}

export interface McpElements {
  server: McpServerElements;
  connect: McpConnectElements;
}

export function mcpElements(): McpElements {
  return {
    server: {
      enabled: byId('mcp-enabled', HTMLInputElement),
      status: byId('mcp-status', HTMLSpanElement),
      error: byId('mcp-error', HTMLParagraphElement),
    },
    connect: {
      kinds: byId('mcp-connect-kinds', HTMLDivElement),
      code: byId('mcp-connect-code', HTMLPreElement),
      copy: byId('mcp-copy', HTMLButtonElement),
      hint: byId('mcp-connect-hint', HTMLSpanElement),
    },
  };
}
