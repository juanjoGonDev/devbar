import type {
  McpAuditFilter,
  McpAuditSelection,
  McpAuditSelectionInfo,
} from '../../src/ipc-contract/mcp-api.js';

/**
 * Which entries of «Actividad» are selected. Plain data plus the rules that
 * change it; mcp-activity-picking.ts paints it and asks main about it.
 *
 * Ticked one by one it is a set of ids, so it survives a new page, sort,
 * search or filter as it is. «Seleccionar las N que coinciden» turns it into
 * the filter itself (with the rows unticked since as exceptions, and rows
 * ticked outside the filter as extras): main resolves that, so selecting
 * thousands of entries never ships thousands of ids. What only main can tell
 * — how many there are now, how many can be undone, which rows of the page
 * belong to a filter — arrives as `info`, tagged with the selection's version
 * so an answer about an older selection is never taken for the current one.
 */

interface MatchSelection {
  filter: McpAuditFilter;
  /** How many entries matched when it was picked. */
  total: number;
  except: Set<string>;
  include: Set<string>;
}

export interface ActivitySelection {
  /** The ids ticked one by one (unused while `match` is set). */
  ids: Set<string>;
  match: MatchSelection | null;
  /** While `match` is set: the rows of the page it holds. */
  onPage: Set<string>;
  /** The row a Shift+click extends from. */
  anchor: string | null;
  /** Bumped by every change. */
  version: number;
  /** Main's latest answer, and the version and page query it was about. */
  info: { version: number; view: string; value: McpAuditSelectionInfo } | null;
}

export type PageState = 'none' | 'some' | 'all';

export function createSelection(): ActivitySelection {
  return {
    ids: new Set(),
    match: null,
    onPage: new Set(),
    anchor: null,
    version: 0,
    info: null,
  };
}

export function isEmpty(sel: ActivitySelection): boolean {
  return sel.match === null && sel.ids.size === 0;
}

export function isPicked(sel: ActivitySelection, id: string): boolean {
  return sel.match ? sel.onPage.has(id) : sel.ids.has(id);
}

/** Main's answer, when it is about this very selection. */
export function freshInfo(
  sel: ActivitySelection,
  view?: string,
): McpAuditSelectionInfo | null {
  const { info } = sel;
  if (!info || info.version !== sel.version) return null;
  return view === undefined || info.view === view ? info.value : null;
}

/** How many are selected: main's count, or the best guess until it answers. */
export function count(sel: ActivitySelection): number {
  const fresh = freshInfo(sel);
  if (fresh) return fresh.total;
  const { match } = sel;
  if (!match) return sel.ids.size;
  return Math.max(0, match.total - match.except.size) + match.include.size;
}

function changed(sel: ActivitySelection): void {
  sel.version++;
}

/** Ticks or unticks these rows of the page. */
export function setPicked(
  sel: ActivitySelection,
  ids: readonly string[],
  on: boolean,
): void {
  const { match } = sel;
  for (const id of ids) {
    if (!match) {
      if (on) sel.ids.add(id);
      else sel.ids.delete(id);
      continue;
    }
    if (on) {
      if (!match.except.delete(id) && !sel.onPage.has(id))
        match.include.add(id);
      sel.onPage.add(id);
    } else {
      if (!match.include.delete(id) && sel.onPage.has(id)) match.except.add(id);
      sel.onPage.delete(id);
    }
  }
  changed(sel);
}

/** A row's box: alone, or with Shift every row from the last one clicked. */
export function pick(
  sel: ActivitySelection,
  pageIds: readonly string[],
  id: string,
  on: boolean,
  shift: boolean,
): void {
  const from = sel.anchor === null ? -1 : pageIds.indexOf(sel.anchor);
  const to = pageIds.indexOf(id);
  if (shift && from >= 0 && to >= 0)
    setPicked(
      sel,
      pageIds.slice(Math.min(from, to), Math.max(from, to) + 1),
      on,
    );
  else setPicked(sel, [id], on);
  sel.anchor = id;
}

export function pageState(
  sel: ActivitySelection,
  pageIds: readonly string[],
): PageState {
  const picked = pageIds.filter((id) => isPicked(sel, id)).length;
  if (picked === 0) return 'none';
  return picked === pageIds.length ? 'all' : 'some';
}

/** Everything `filter` matches (`total` of them, `pageIds` on screen). */
export function pickEveryMatch(
  sel: ActivitySelection,
  filter: McpAuditFilter,
  total: number,
  pageIds: readonly string[],
): void {
  sel.ids = new Set();
  sel.match = { filter, total, except: new Set(), include: new Set() };
  sel.onPage = new Set(pageIds);
  changed(sel);
}

export function clearSelection(sel: ActivitySelection): void {
  sel.ids = new Set();
  sel.match = null;
  sel.onPage = new Set();
  sel.anchor = null;
  sel.info = null;
  changed(sel);
}

const sameFilter = (a: McpAuditFilter, b: McpAuditFilter): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Whether every entry `filter` matches is selected. */
export function everyMatch(
  sel: ActivitySelection,
  filter: McpAuditFilter,
  view: string,
): boolean {
  const fresh = freshInfo(sel, view);
  if (fresh?.view) return fresh.view.everyMatch;
  const { match } = sel;
  return (
    match !== null &&
    match.except.size === 0 &&
    sameFilter(match.filter, filter)
  );
}

/** Takes main's answer; the rows of a filter selection come from it. */
export function takeInfo(
  sel: ActivitySelection,
  version: number,
  view: string,
  value: McpAuditSelectionInfo,
): void {
  if (version !== sel.version) return;
  sel.info = { version, view, value };
  if (sel.match && value.view) sel.onPage = new Set(value.view.onPage);
}

/** What main is told the selection is. */
export function toWire(sel: ActivitySelection): McpAuditSelection {
  const { match } = sel;
  if (!match) return { kind: 'ids', ids: [...sel.ids] };
  return {
    kind: 'query',
    query: match.filter,
    ...(match.except.size > 0 ? { except: [...match.except] } : {}),
    ...(match.include.size > 0 ? { include: [...match.include] } : {}),
  };
}
