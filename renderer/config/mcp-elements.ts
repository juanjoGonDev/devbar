import { byId } from '../dom.js';
import type { McpActivityElements } from './mcp-activity.js';
import type { McpSheetElements } from './mcp-client-sheet.js';
import type { McpClientListElements } from './mcp-clients.js';
import type { McpRevokeElements } from './mcp-revoke-dialog.js';

/**
 * Every element of the «MCP» section (both tabs), its permissions sheet and
 * its revoke confirmation, resolved in one place: config.ts calls this once, and
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
  revoke: McpRevokeElements;
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
    revoke: {
      dialog: byId('mcp-revoke-dialog', HTMLDialogElement),
      title: byId('mcp-revoke-title', HTMLHeadingElement),
      client: byId('mcp-revoke-client', HTMLDivElement),
      cancel: byId('mcp-revoke-cancel', HTMLButtonElement),
      confirm: byId('mcp-revoke-confirm', HTMLButtonElement),
    },
    activity: {
      setupTab: byId('mcp-tab-setup', HTMLButtonElement),
      activityTab: byId('mcp-tab-activity', HTMLButtonElement),
      setup: byId('mcp-setup', HTMLDivElement),
      activity: byId('mcp-activity', HTMLDivElement),
      search: byId('mcp-activity-search', HTMLInputElement),
      searchClear: byId('mcp-activity-search-clear', HTMLButtonElement),
      searchKey: byId('mcp-activity-search-key', HTMLElement),
      fresh: byId('mcp-activity-fresh', HTMLButtonElement),
      active: byId('mcp-activity-active', HTMLDivElement),
      log: byId('mcp-activity-log', HTMLDivElement),
      head: byId('mcp-activity-head', HTMLDivElement),
      rows: byId('mcp-activity-rows', HTMLUListElement),
      range: byId('mcp-activity-range', HTMLSpanElement),
      size: byId('mcp-activity-size', HTMLSelectElement),
      pages: byId('mcp-activity-pages', HTMLDivElement),
    },
  };
}
