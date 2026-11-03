import type {
  McpAuditEntry,
  McpAuditFilter,
  McpAuditQuery,
  McpClient,
} from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import { latestWins } from '../latest-wins.js';
import { auditResultLabel, auditTime } from './mcp-format.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «Actividad»: the second tab of the «MCP» section. The audit log main keeps
 * (newest first), filtered by kind and client, read the first time the tab
 * opens and again on every filter change; new entries arrive live. A change
 * unfolds into its diff and offers «Deshacer» while main still can.
 */

export interface McpActivityElements {
  setupTab: HTMLButtonElement;
  activityTab: HTMLButtonElement;
  setup: HTMLElement;
  activity: HTMLElement;
  filters: HTMLElement;
  client: HTMLSelectElement;
  rows: HTMLUListElement;
  empty: HTMLElement;
}

export interface McpActivity {
  /** The clients the «Cliente» filter offers. */
  setClients(clients: readonly McpClient[]): void;
}

/** How many entries one read brings back. */
const PAGE = 200;

function isFilter(value: string | undefined): value is McpAuditFilter {
  return value === 'all' || value === 'changes' || value === 'rejected';
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

const DIFF_SIGN = { ctx: ' ', del: '-', add: '+' } as const;

export function createMcpActivity(
  els: McpActivityElements,
  showToast: ShowToast,
): McpActivity {
  let filter: McpAuditFilter = 'all';
  let clientId = '';
  let loaded = false;
  let shown: McpAuditEntry[] = [];
  const reads = latestWins();

  function matches(entry: McpAuditEntry): boolean {
    if (clientId && entry.clientId !== clientId) return false;
    if (filter === 'changes') return entry.diff !== undefined;
    if (filter === 'rejected') return entry.result === 'rejected';
    return true;
  }

  function undoButton(token: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small-btn mcp-entry-undo';
    button.append(icon('undo-2'), 'Deshacer');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await window.api.undoMcpChange(token);
        if (result.ok) {
          showToast('Cambio deshecho', 'ok');
          void load();
        } else {
          showToast(result.error ?? 'No se pudo deshacer.', 'error');
          button.disabled = false;
        }
      } catch (err) {
        showToast(`Error: ${errorMessage(err)}`, 'error');
        button.disabled = false;
      }
    });
    return button;
  }

  function row(entry: McpAuditEntry): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'mcp-entry';
    li.dataset.id = entry.id;

    const line = document.createElement('div');
    line.className = 'mcp-entry-line';
    const action = span('mcp-entry-action', '');
    action.append(span('mcp-entry-tool', entry.tool));
    if (entry.target) action.append(` · ${entry.target}`);
    if (entry.summary)
      action.append(span('mcp-entry-summary', ` · ${entry.summary}`));
    const result = span('mcp-entry-result', auditResultLabel(entry));
    result.dataset.result = entry.result;
    const tail = span('mcp-entry-tail', '');
    line.append(
      span('mcp-entry-time', auditTime(entry.at)),
      span('mcp-entry-client', entry.clientName),
      action,
      result,
      tail,
    );
    li.append(line);

    if (entry.diff) {
      const diff = document.createElement('div');
      diff.className = 'mcp-diff';
      diff.id = `mcp-diff-${entry.id}`;
      diff.hidden = true;
      for (const change of entry.diff) {
        const diffLine = document.createElement('div');
        diffLine.className = 'mcp-diff-line';
        diffLine.dataset.kind = change.kind;
        diffLine.textContent = `${DIFF_SIGN[change.kind]} ${change.field}: ${change.text}`;
        diff.append(diffLine);
      }
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mcp-entry-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', diff.id);
      toggle.setAttribute('aria-label', 'Ver el cambio');
      toggle.append(icon('chevron-right'));
      toggle.addEventListener('click', () => {
        diff.hidden = !diff.hidden;
        toggle.setAttribute('aria-expanded', String(!diff.hidden));
        li.classList.toggle('is-open', !diff.hidden);
      });
      tail.append(toggle);
      li.classList.add('is-change');
      li.append(diff);
    }
    if (entry.undoToken) tail.prepend(undoButton(entry.undoToken));
    return li;
  }

  function render(): void {
    els.rows.replaceChildren(...shown.map(row));
    els.empty.hidden = shown.length > 0;
  }

  async function load(): Promise<void> {
    reads.invalidate();
    const current = reads.claim();
    const query: McpAuditQuery = { filter, limit: PAGE };
    if (clientId) query.clientId = clientId;
    try {
      const list = await window.api.listMcpAudit(query);
      if (!current()) return;
      shown = list;
      loaded = true;
      render();
    } catch (err) {
      if (current())
        showToast(`Error al leer la actividad: ${errorMessage(err)}`, 'error');
    }
  }

  function showTab(activity: boolean): void {
    els.setupTab.setAttribute('aria-selected', String(!activity));
    els.activityTab.setAttribute('aria-selected', String(activity));
    els.setup.hidden = activity;
    els.activity.hidden = !activity;
    if (activity && !loaded) void load();
  }
  els.setupTab.addEventListener('click', () => showTab(false));
  els.activityTab.addEventListener('click', () => showTab(true));

  els.filters.addEventListener('click', (event) => {
    const chip =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-filter]')
        : null;
    const picked = chip?.dataset.filter;
    if (!isFilter(picked) || picked === filter) return;
    filter = picked;
    for (const each of els.filters.querySelectorAll<HTMLElement>(
      '[data-filter]',
    ))
      each.setAttribute('aria-pressed', String(each === chip));
    void load();
  });

  els.client.addEventListener('change', () => {
    clientId = els.client.value;
    void load();
  });

  window.api.onMcpAudit((entry) => {
    if (!loaded || !matches(entry)) return;
    shown = [entry, ...shown.filter((each) => each.id !== entry.id)].slice(
      0,
      PAGE,
    );
    render();
  });

  return {
    setClients(clients) {
      const options = clients.map(
        (client) => new Option(client.name, client.id),
      );
      els.client.replaceChildren(
        new Option('Todos los clientes', ''),
        ...options,
      );
      // A client that is gone keeps its filter only while it is listed.
      els.client.value = clients.some((client) => client.id === clientId)
        ? clientId
        : '';
      if (els.client.value !== clientId) {
        clientId = '';
        if (loaded) void load();
      }
    },
  };
}
