import type {
  McpAuditEntry,
  McpAuditFacets,
  McpAuditPage,
} from '../../src/ipc-contract/mcp-api.js';
import { AUDIT_RETENTION_DAYS } from '../../src/mcp-audit-labels.js';
import { latestWins } from '../latest-wins.js';
import { renderActive } from './mcp-activity-active.js';
import {
  createActivityDialog,
  type McpActivityDialogElements,
} from './mcp-activity-ask.js';
import { confirmUndoOne } from './mcp-activity-bulk.js';
import {
  createActivityClean,
  type McpCleanElements,
} from './mcp-activity-clean.js';
import { createActivityHead } from './mcp-activity-head.js';
import {
  clearColumn,
  clickSort,
  columnOf,
  COLUMNS,
  dropSort,
  groupsByDay,
  initialState,
  isDefaultSort,
  narrows,
  pickSort,
  toFilter,
  toQuery,
  type ActivityColumn,
} from './mcp-activity-model.js';
import { pageCount, renderPager } from './mcp-activity-pager.js';
import { createActivityPicking } from './mcp-activity-picking.js';
import { renderRows } from './mcp-activity-rows.js';
import { createActivitySearch } from './mcp-activity-search.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «Actividad»: the second tab of the «MCP» section, the audit log of every
 * tool call. Main keeps the days the user chose (30 by default) and answers
 * one page at a time (`queryMcpAudit`): this owns what the user asked for —
 * search, column filters, sort keys, page — and repaints whatever main
 * answered last. The pieces around it live next door: the header and its
 * column menus, the rows, the selection and its bar, «Limpiar», the pager and
 * the line of active filters.
 *
 * New calls arrive live. On the first page in the usual order the log reads
 * itself again; anywhere else it would move what the user is looking at, so
 * it only offers «Actualizar». Entries that leave the log (deleted, pruned)
 * read it again wherever the user is.
 *
 * Only the rows scroll (renderer/styles.css): whatever the user asks for
 * next starts them back at the top, and a faint shadow under the header says
 * there is more above while they are scrolled.
 */

export interface McpActivityElements {
  setupTab: HTMLButtonElement;
  activityTab: HTMLButtonElement;
  setup: HTMLElement;
  activity: HTMLElement;
  search: HTMLInputElement;
  searchClear: HTMLButtonElement;
  searchKey: HTMLElement;
  fresh: HTMLButtonElement;
  active: HTMLElement;
  log: HTMLElement;
  head: HTMLElement;
  rows: HTMLUListElement;
  range: HTMLElement;
  size: HTMLSelectElement;
  pages: HTMLElement;
  /** «Se guardan los últimos N días…» under the log. */
  keep: HTMLElement;
  clean: McpCleanElements;
  dialog: McpActivityDialogElements;
}

export interface McpActivityDeps {
  showToast: ShowToast;
  platform: string;
}

/** Calls rarely come alone: one read for a burst of them. */
export const LIVE_DELAY_MS = 300;

export function createMcpActivity(
  els: McpActivityElements,
  deps: McpActivityDeps,
): void {
  const { showToast } = deps;
  const state = initialState();
  let page: McpAuditPage | null = null;
  let loaded = false;
  let live: ReturnType<typeof setTimeout> | null = null;
  /** The next paint answers a new question: show its rows from the top. */
  let toTop = false;
  const reads = latestWins();

  const facets = (): McpAuditFacets | null => page?.facets ?? null;
  const days = (): number =>
    page?.retentionDays ?? AUDIT_RETENTION_DAYS.default;
  const shown = (): boolean =>
    !els.activity.hidden &&
    (els.activity.closest('.config-section')?.classList.contains('active') ??
      false);
  const dialog = createActivityDialog(els.dialog);
  const bulk = { dialog, showToast };

  /** A new question for main: back to the first page unless told not to. */
  function change(firstPage = true): void {
    if (firstPage) state.page = 1;
    toTop = true;
    head.render();
    void load();
  }
  const setSort = (next: typeof state.sort): void => {
    state.sort = next;
    change();
  };
  const clear = (column: ActivityColumn): void => {
    clearColumn(state, column);
    change();
  };

  const head = createActivityHead(els.head, {
    state: () => state,
    facets,
    now: () => Date.now(),
    retentionDays: days,
    clickSort: (key, additive) => setSort(clickSort(state.sort, key, additive)),
    sort: (key, dir) => setSort(pickSort(state.sort, key, dir, false)),
    addSort: (key) =>
      setSort(pickSort(state.sort, key, columnOf(key).first, true)),
    removeSort: (key) => setSort(dropSort(state.sort, key)),
    setTime: (time) => {
      state.time = time;
      change();
    },
    select: (column, next) => {
      if (column === 'client') state.clients = next;
      else if (column === 'action') state.tools = next;
      else state.results = next as typeof state.results;
      change();
    },
    setUndoable: (on) => {
      state.undoable = on;
      change();
    },
    clear,
  });

  createActivitySearch(
    { input: els.search, clear: els.searchClear, shortcut: els.searchKey },
    {
      platform: deps.platform,
      shown,
      apply: (text) => {
        state.search = text;
        change();
      },
    },
  );

  /** The query of the page on show (its time window fixed when asked). */
  let shownQuery = toQuery(state, Date.now());
  // Before the selection: Escape closes an open «Limpiar» first.
  createActivityClean(els.clean, {
    ...bulk,
    now: () => Date.now(),
    retentionDays: days,
    page: () => page,
    narrows: () => narrows(state),
    filter: () => toFilter(shownQuery),
    reload: () => void load(),
  });
  const picking = createActivityPicking(els.head, els.rows, {
    ...bulk,
    shown,
    page: () => page,
    query: () => shownQuery,
    filter: () => toFilter(shownQuery),
    reload: () => void load(),
  });

  async function undo(
    entry: McpAuditEntry,
    token: string,
    button: HTMLButtonElement,
  ): Promise<void> {
    const busy = (on: boolean): void => {
      button.disabled = on;
    };
    if (await confirmUndoOne(bulk, entry, token, busy)) void load();
  }

  function go(next: number): void {
    state.page = next;
    change(false);
  }

  function scrolled(): void {
    els.rows.classList.toggle('is-scrolled', els.rows.scrollTop > 0);
  }

  /** Every column filter off and newest first again; the search stays. */
  function reset(): void {
    for (const column of COLUMNS) clearColumn(state, column.key);
    state.sort = initialState().sort;
    change();
  }

  function paint(): void {
    head.render();
    const byDay = groupsByDay(state.sort);
    els.log.classList.toggle('is-flat', !byDay);
    const total = page?.total ?? 0;
    const retained = page?.retained ?? 0;
    renderRows(els.rows, page?.entries ?? [], {
      search: state.search,
      byDay,
      now: Date.now(),
      empty: retained === 0 ? 'none' : 'filtered',
      undo: (entry, token, button) => void undo(entry, token, button),
      ...picking.rows,
      banner: picking.banner(),
    });
    picking.paint();
    renderPager(
      { range: els.range, pages: els.pages },
      {
        page: state.page,
        size: state.size,
        total,
        shown: page?.entries.length ?? 0,
      },
      go,
    );
    renderActive(
      els.active,
      { state, facets: facets(), total, retained, days: days() },
      reset,
    );
    els.keep.textContent = `${days() === 1 ? 'Se guarda el último día' : `Se guardan los últimos ${days()} días`}. Los logs que lee un asistente no se copian aquí.`;
    if (toTop) {
      toTop = false;
      els.rows.scrollTop = 0;
      scrolled();
    }
  }

  function stopLive(): void {
    if (live !== null) clearTimeout(live);
    live = null;
  }

  async function load(): Promise<void> {
    stopLive();
    els.fresh.hidden = true;
    reads.invalidate();
    const current = reads.claim();
    try {
      const asked = toQuery(state, Date.now());
      const next = await window.api.queryMcpAudit(asked);
      if (!current()) return;
      // The page emptied under the user (entries went): go to the last.
      const last = pageCount(next.total, state.size);
      if (next.entries.length === 0 && state.page > last) {
        state.page = last;
        void load();
        return;
      }
      page = next;
      shownQuery = asked;
      loaded = true;
      await picking.loaded();
      if (!current()) return;
      paint();
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

  els.size.addEventListener('change', () => {
    state.size = Number(els.size.value) || state.size;
    change();
  });
  els.fresh.addEventListener('click', () => void load());
  els.rows.addEventListener('scroll', scrolled, { passive: true });

  window.api.onMcpAuditRefresh(() => {
    if (loaded) void load();
  });
  window.api.onMcpAudit(() => {
    if (!loaded) return;
    if (state.page === 1 && isDefaultSort(state.sort)) {
      stopLive();
      live = setTimeout(() => {
        live = null;
        void load();
      }, LIVE_DELAY_MS);
    } else {
      els.fresh.hidden = false;
    }
  });

  head.render();
}
