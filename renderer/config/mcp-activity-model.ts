import type {
  McpAuditFacets,
  McpAuditPageQuery,
  McpAuditResult,
  McpAuditSort,
  McpAuditSortKey,
} from '../../src/ipc-contract/mcp-api.js';
import { AUDIT_RESULT_LABELS } from '../../src/mcp-audit-labels.js';

/**
 * What «Actividad» is showing: the search, each column's filter, the sort
 * keys and the page. Plain data plus the rules that change it, so the views
 * around it only paint; main does the filtering itself
 * (src/main/mcp/audit-query.ts) from the query this builds.
 */

export type ActivityColumn = McpAuditSortKey;
export type TimePreset = 'all' | '1h' | 'today' | '7d' | 'custom';
export type SortDir = McpAuditSort['dir'];

export interface TimeFilter {
  when: TimePreset;
  /** Local `YYYY-MM-DDTHH:MM` values (to the minute); '' leaves that end open. */
  from: string;
  to: string;
}

export interface ActivityState {
  /** The search as applied (the field debounces into it). */
  search: string;
  sort: McpAuditSort[];
  time: TimeFilter;
  /** null shows every value; a set only those. */
  clients: ReadonlySet<string> | null;
  tools: ReadonlySet<string> | null;
  results: ReadonlySet<McpAuditResult> | null;
  undoable: boolean;
  /** 1-based. */
  page: number;
  size: number;
}

export interface ColumnDef {
  key: ActivityColumn;
  label: string;
  /** The sort menu's two entries. */
  asc: string;
  desc: string;
  /** The direction a first click sorts by. */
  first: SortDir;
}

export const COLUMNS: readonly ColumnDef[] = [
  {
    key: 'time',
    label: 'Hora',
    asc: 'Más antiguo primero',
    desc: 'Más reciente primero',
    first: 'desc',
  },
  {
    key: 'client',
    label: 'Cliente',
    asc: 'A → Z',
    desc: 'Z → A',
    first: 'asc',
  },
  { key: 'action', label: 'Acción', asc: 'A → Z', desc: 'Z → A', first: 'asc' },
  {
    key: 'result',
    label: 'Resultado',
    asc: 'Correcto primero',
    desc: 'Errores primero',
    first: 'desc',
  },
];

export function columnOf(key: ActivityColumn): ColumnDef {
  return COLUMNS.find((column) => column.key === key) ?? COLUMNS[0]!;
}

export const TIME_PRESETS: readonly (readonly [TimePreset, string])[] = [
  ['all', 'Siempre'],
  ['1h', 'Última hora'],
  ['today', 'Hoy'],
  ['7d', '7 días'],
  ['custom', 'Rango…'],
];

const DEFAULT_SIZE = 50;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINUTE = 60 * 1000;

const NEWEST_FIRST: McpAuditSort = { key: 'time', dir: 'desc' };

export function initialState(): ActivityState {
  return {
    search: '',
    sort: [{ ...NEWEST_FIRST }],
    time: { when: 'all', from: '', to: '' },
    clients: null,
    tools: null,
    results: null,
    undoable: false,
    page: 1,
    size: DEFAULT_SIZE,
  };
}

/** Newest first, the order the log reads in until the user picks another. */
export function isDefaultSort(sort: readonly McpAuditSort[]): boolean {
  return (
    sort.length === 1 &&
    sort[0]?.key === NEWEST_FIRST.key &&
    sort[0]?.dir === NEWEST_FIRST.dir
  );
}

/** Day separators make sense only while the time leads the sort. */
export function groupsByDay(sort: readonly McpAuditSort[]): boolean {
  return sort[0]?.key === 'time';
}

const orDefault = (sort: McpAuditSort[]): McpAuditSort[] =>
  sort.length > 0 ? sort : [{ ...NEWEST_FIRST }];

/** Sorts by `key` in `dir`: alone, or added to (or updated in) the keys. */
export function pickSort(
  sort: readonly McpAuditSort[],
  key: ActivityColumn,
  dir: SortDir,
  additive: boolean,
): McpAuditSort[] {
  if (!additive) return [{ key, dir }];
  const at = sort.findIndex((each) => each.key === key);
  if (at < 0) return [...sort, { key, dir }];
  return sort.map((each, index) => (index === at ? { key, dir } : each));
}

export function dropSort(
  sort: readonly McpAuditSort[],
  key: ActivityColumn,
): McpAuditSort[] {
  return orDefault(sort.filter((each) => each.key !== key));
}

/**
 * A header click: its first direction, then the other. With Shift it adds
 * the column as one more key, and a third Shift+click takes it out again.
 */
export function clickSort(
  sort: readonly McpAuditSort[],
  key: ActivityColumn,
  additive: boolean,
): McpAuditSort[] {
  const { first } = columnOf(key);
  const current = sort.find((each) => each.key === key);
  if (additive && current && current.dir !== first) return dropSort(sort, key);
  const dir: SortDir = !current
    ? first
    : current.dir === 'asc'
      ? 'desc'
      : 'asc';
  return pickSort(sort, key, dir, additive);
}

export function isFiltered(
  state: ActivityState,
  column: ActivityColumn,
): boolean {
  switch (column) {
    case 'time':
      return state.time.when !== 'all';
    case 'client':
      return state.clients !== null;
    case 'action':
      return state.tools !== null;
    case 'result':
      return state.results !== null || state.undoable;
  }
}

/** Anything that narrows the log: a column filter or the search. */
export function narrows(state: ActivityState): boolean {
  return (
    state.search.trim() !== '' ||
    COLUMNS.some((column) => isFiltered(state, column.key))
  );
}

export function clearColumn(
  state: ActivityState,
  column: ActivityColumn,
): void {
  switch (column) {
    case 'time':
      state.time = { when: 'all', from: '', to: '' };
      return;
    case 'client':
      state.clients = null;
      return;
    case 'action':
      state.tools = null;
      return;
    case 'result':
      state.results = null;
      state.undoable = false;
      return;
  }
}

/** A `YYYY-MM-DDTHH:MM` value in local time, to the minute. */
export function localInput(ms: number): string {
  const offset = new Date(ms).getTimezoneOffset() * MINUTE;
  return new Date(ms - offset).toISOString().slice(0, 16);
}

/** A `YYYY-MM-DDTHH:MM` value as epoch ms, or undefined when empty or invalid. */
export function parseLocal(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** The epoch-ms window a time filter covers at `now`. */
export function timeWindow(
  time: TimeFilter,
  now: number,
): { from?: number; to?: number } {
  switch (time.when) {
    case 'all':
      return {};
    case '1h':
      return { from: now - HOUR };
    case 'today': {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return { from: midnight.getTime() };
    }
    case '7d':
      return { from: now - 7 * DAY };
    case 'custom': {
      const from = parseLocal(time.from);
      const to = parseLocal(time.to);
      return {
        ...(from === undefined ? {} : { from }),
        // «Hasta 10:30» keeps everything up to 10:30:59.
        ...(to === undefined ? {} : { to: to + MINUTE - 1 }),
      };
    }
  }
}

/** The query main answers for this state at `now`. */
export function toQuery(state: ActivityState, now: number): McpAuditPageQuery {
  const query: McpAuditPageQuery = {
    offset: (state.page - 1) * state.size,
    limit: state.size,
    sort: state.sort.map((each) => ({ ...each })),
    ...timeWindow(state.time, now),
  };
  const search = state.search.trim();
  if (search) query.search = search;
  if (state.clients) query.clientIds = [...state.clients];
  if (state.tools) query.tools = [...state.tools];
  if (state.results) query.results = [...state.results];
  if (state.undoable) query.undoable = true;
  return query;
}

const SHORT_STAMP = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** «6 nov 08:38», for the flat time column and the range pill. */
export function shortStamp(ms: number): string {
  return SHORT_STAMP.format(ms).replace(',', '');
}

function listOf(names: readonly string[], none: string): string {
  return names.length > 0 ? names.join(', ') : none;
}

/** What a column filter keeps, in words, for its pill. */
export function describeFilter(
  state: ActivityState,
  column: ActivityColumn,
  facets: McpAuditFacets | null,
): string {
  switch (column) {
    case 'time': {
      const { when, from, to } = state.time;
      if (when !== 'custom')
        return TIME_PRESETS.find(([preset]) => preset === when)?.[1] ?? '';
      const fromMs = parseLocal(from);
      const toMs = parseLocal(to);
      return `${fromMs === undefined ? '…' : shortStamp(fromMs)} → ${toMs === undefined ? 'ahora' : shortStamp(toMs)}`;
    }
    case 'client': {
      const names = new Map(facets?.clients.map((c) => [c.id, c.name]) ?? []);
      const ids = [...(state.clients ?? [])];
      return listOf(
        ids.map((id) => names.get(id) ?? id),
        'ninguno',
      );
    }
    case 'action': {
      const tools = [...(state.tools ?? [])];
      if (tools.length === 1) return tools[0] ?? '';
      return tools.length === 0 ? 'ninguna' : `${tools.length} herramientas`;
    }
    case 'result': {
      const parts: string[] = [];
      if (state.results)
        parts.push(
          listOf(
            [...state.results].map((result) => AUDIT_RESULT_LABELS[result]),
            'ninguno',
          ),
        );
      if (state.undoable) parts.push('se puede deshacer');
      return parts.join(' · ');
    }
  }
}
