import { byId } from '../dom.js';
import type { McpActivityElements } from './mcp-activity.js';
import type { McpSheetElements } from './mcp-client-sheet.js';
import type { McpClientListElements } from './mcp-clients.js';

/**
 * Every element of the «MCP» section (both tabs) and its permissions sheet,
 * resolved in one place: config.ts calls this once, and
 * tests/renderer-dom-contract.test.ts checks each assertion against
 * config.html.
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
  clients: McpClientListElements;
  sheet: McpSheetElements;
  activity: McpActivityElements;
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
    clients: {
      list: byId('mcp-clients', HTMLUListElement),
      empty: byId('mcp-clients-empty', HTMLParagraphElement),
      revoked: byId('mcp-revoked', HTMLDetailsElement),
      revokedSummary: byId('mcp-revoked-summary', HTMLElement),
      revokedList: byId('mcp-revoked-list', HTMLUListElement),
    },
    sheet: {
      dialog: byId('mcp-client-sheet', HTMLDialogElement),
      form: byId('mcp-sheet-form', HTMLFormElement),
      avatar: byId('mcp-sheet-avatar', HTMLSpanElement),
      title: byId('mcp-sheet-title', HTMLHeadingElement),
      scopes: byId('mcp-sheet-scopes', HTMLDivElement),
      groupsAll: byId('mcp-sheet-groups-all', HTMLInputElement),
      groupsSome: byId('mcp-sheet-groups-some', HTMLInputElement),
      groups: byId('mcp-sheet-groups', HTMLDivElement),
      redact: byId('mcp-sheet-redact', HTMLInputElement),
      connection: byId('mcp-sheet-connection', HTMLSpanElement),
      revoke: byId('mcp-sheet-revoke', HTMLButtonElement),
      submit: byId('mcp-sheet-submit', HTMLButtonElement),
      submitLabel: byId('mcp-sheet-submit-label', HTMLSpanElement),
      shortcutKey: byId('mcp-sheet-key', HTMLElement),
      warning: {
        dialog: byId('mcp-config-warning', HTMLDialogElement),
        title: byId('mcp-config-warning-title', HTMLHeadingElement),
        body: byId('mcp-config-warning-body', HTMLParagraphElement),
        cancel: byId('mcp-config-warning-cancel', HTMLButtonElement),
        allow: byId('mcp-config-warning-allow', HTMLButtonElement),
      },
    },
    activity: {
      setupTab: byId('mcp-tab-setup', HTMLButtonElement),
      activityTab: byId('mcp-tab-activity', HTMLButtonElement),
      setup: byId('mcp-setup', HTMLDivElement),
      activity: byId('mcp-activity', HTMLDivElement),
      filters: byId('mcp-activity-filters', HTMLDivElement),
      client: byId('mcp-activity-client', HTMLSelectElement),
      rows: byId('mcp-activity-rows', HTMLUListElement),
      empty: byId('mcp-activity-empty', HTMLParagraphElement),
    },
  };
}
