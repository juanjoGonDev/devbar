/**
 * Drives «Actividad» (Settings › MCP) through the real config window: the
 * page main answers with, opening the tab, and the parts of the table a test
 * reads or clicks — header cells, the open column menu, rows, pager, pills.
 */
import type {
  McpAuditEntry,
  McpAuditFacets,
  McpAuditPage,
  McpAuditPageQuery,
  McpAuditResult,
} from '../../src/ipc-contract/mcp-api.js';
import { click, el, mcpClient, mcpState, openMcp, visible } from './mcp.js';
import type { RendererWindow } from './renderer-dom.js';

const RESULTS: readonly McpAuditResult[] = [
  'ok',
  'warning',
  'error',
  'rejected',
  'pending',
];

/** Counts every value of `entries`, the way main would with no filter. */
function facetsOf(entries: readonly McpAuditEntry[]): McpAuditFacets {
  const count = <K>(key: (e: McpAuditEntry) => K, value: K): number =>
    entries.filter((e) => key(e) === value).length;
  const clients = [...new Map(entries.map((e) => [e.clientId, e.clientName]))];
  const tools = [...new Set(entries.map((e) => e.tool))];
  return {
    clients: clients.map(([id, name]) => ({
      id,
      name,
      count: count((e) => e.clientId, id),
    })),
    tools: tools.map((tool) => ({
      tool,
      family: 'read' as const,
      count: count((e) => e.tool, tool),
    })),
    results: RESULTS.map((result) => ({
      result,
      count: count((e) => e.result, result),
    })),
  };
}

export function auditPage(
  entries: readonly McpAuditEntry[],
  extra: Partial<McpAuditPage> = {},
): McpAuditPage {
  return {
    entries: [...entries],
    total: entries.length,
    retained: entries.length,
    facets: facetsOf(entries),
    ...extra,
  };
}

/** The config window on «Actividad», its first read answered with `first`. */
export async function openActivity(
  first: McpAuditPage | readonly McpAuditEntry[],
): Promise<RendererWindow> {
  const win = await openMcp(
    mcpState({ clients: [mcpClient('Claude Code'), mcpClient('Cursor')] }),
  );
  click(el('mcp-tab-activity'));
  await win.settle(
    'queryMcpAudit',
    Array.isArray(first) ? auditPage(first) : first,
  );
  return win;
}

/** The query of the newest read. */
export function lastQuery(win: RendererWindow): McpAuditPageQuery {
  const args = win.argsFor('queryMcpAudit').at(-1);
  if (!args) throw new Error('no query yet');
  return args[0] as McpAuditPageQuery;
}

export function rowIds(): string[] {
  return [
    ...el('mcp-activity-rows').querySelectorAll<HTMLElement>('.mcp-entry'),
  ].map((row) => row.dataset.id ?? '');
}

export function row(id: string): HTMLElement {
  const found = el('mcp-activity-rows').querySelector<HTMLElement>(
    `.mcp-entry[data-id="${id}"]`,
  );
  if (!found) throw new Error(`no entry ${id}`);
  return found;
}

const COLUMN_KEYS: Readonly<Record<string, string>> = {
  Hora: 'time',
  Cliente: 'client',
  Acción: 'action',
  Resultado: 'result',
};

export function cell(label: string): HTMLElement {
  const found = el('mcp-activity-head').querySelector<HTMLElement>(
    `.xh[data-column="${COLUMN_KEYS[label] ?? label}"]`,
  );
  if (!found) throw new Error(`no column ${label}`);
  return found;
}

export function sortButton(label: string): HTMLButtonElement {
  const found = cell(label).querySelector<HTMLButtonElement>('.xh-sort');
  if (!found) throw new Error(`no sort button for ${label}`);
  return found;
}

export function funnel(label: string): HTMLButtonElement {
  const found = cell(label).querySelector<HTMLButtonElement>('.xh-funnel');
  if (!found) throw new Error(`no funnel for ${label}`);
  return found;
}

export function shiftClick(target: Element): void {
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, shiftKey: true }),
  );
}

export function openMenu(): HTMLElement | null {
  return el('mcp-activity-head').querySelector<HTMLElement>('.xf');
}

export function menu(): HTMLElement {
  const found = openMenu();
  if (!found) throw new Error('no open column menu');
  return found;
}

/** A menu entry (sort item, chip or button) by what it reads. */
export function menuButton(label: string): HTMLButtonElement {
  const found = [...menu().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => visible(button) === label,
  );
  if (!found) throw new Error(`no «${label}» in the menu`);
  return found;
}

/** The checklist rows as `[label, count, state]`. */
export function checks(): [string, string, string][] {
  return [...menu().querySelectorAll<HTMLElement>('.xf-check')].map((row) => {
    const box = row.querySelector<HTMLInputElement>('input');
    const state = box?.indeterminate ? 'mixed' : box?.checked ? 'on' : 'off';
    return [
      row.querySelector('.xf-check-label')?.textContent ?? '',
      row.querySelector('.n')?.textContent ?? '',
      state,
    ];
  });
}

export function checkbox(label: string): HTMLInputElement {
  const found = [...menu().querySelectorAll<HTMLElement>('.xf-check')].find(
    (row) => row.querySelector('.xf-check-label')?.textContent === label,
  );
  const box = found?.querySelector<HTMLInputElement>('input');
  if (!box) throw new Error(`no box «${label}»`);
  return box;
}

/** Ticks or unticks a box the way a click does. */
export function toggle(box: HTMLInputElement): void {
  box.click();
}

export function pills(): string[] {
  return [...el('mcp-activity-active').querySelectorAll('.act-pill')].map(
    (pill) => visible(pill),
  );
}

export function activeLine(): string {
  return visible(el('mcp-activity-active'));
}
