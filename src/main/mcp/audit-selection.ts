import type {
  McpAuditEntry,
  McpAuditPageQuery,
  McpAuditSelection,
  McpAuditSelectionInfo,
  McpAuditSelectionView,
} from '../../ipc-contract/mcp-api.js';
import { filterAuditEntries, paged } from './audit-query.js';

/**
 * What a selection of «Actividad» stands for, resolved over the entries the
 * log holds. The window only sends how the user picked (ids, a filter with
 * its exceptions, a time window or everything), so selecting thousands of
 * entries never ships thousands of ids; this turns that into the entries
 * themselves and into the counts the window shows about them. Pure, like
 * audit-query.ts: the log stays the only thing that knows about the file.
 */

const inWindow = (entry: McpAuditEntry, from?: number, to?: number): boolean =>
  entry.at >= (from ?? -Infinity) && entry.at <= (to ?? Infinity);

/** The entries `selection` picks, in the log's own order. */
export function resolveSelection(
  all: readonly McpAuditEntry[],
  selection: McpAuditSelection,
): McpAuditEntry[] {
  switch (selection.kind) {
    case 'all':
      return [...all];
    case 'range':
      return all.filter((entry) =>
        inWindow(entry, selection.from, selection.to),
      );
    case 'ids': {
      const ids = new Set(selection.ids);
      return all.filter((entry) => ids.has(entry.id));
    }
    case 'query': {
      const except = new Set(selection.except ?? []);
      const include = new Set(selection.include ?? []);
      const matched = new Set(filterAuditEntries(all, selection.query));
      return all.filter(
        (entry) =>
          include.has(entry.id) ||
          (matched.has(entry) && !except.has(entry.id)),
      );
    }
  }
}

/** Where the selected entries sit in one page query. */
function viewOf(
  all: readonly McpAuditEntry[],
  picked: ReadonlySet<string>,
  query: McpAuditPageQuery,
): McpAuditSelectionView {
  const { matching, offset, limit } = paged(all, query);
  const pages = new Set<number>();
  let inside = 0;
  matching.forEach((entry, index) => {
    if (!picked.has(entry.id)) return;
    inside++;
    pages.add(Math.floor(index / limit));
  });
  return {
    outside: picked.size - inside,
    pages: pages.size,
    onPage: matching
      .slice(offset, offset + limit)
      .filter((entry) => picked.has(entry.id))
      .map((entry) => entry.id),
    everyMatch: matching.length > 0 && inside === matching.length,
  };
}

export function selectionInfo(
  all: readonly McpAuditEntry[],
  selection: McpAuditSelection,
  view?: McpAuditPageQuery,
): McpAuditSelectionInfo {
  const entries = resolveSelection(all, selection);
  let oldest: number | null = null;
  let undoable = 0;
  for (const entry of entries) {
    if (entry.undoToken !== undefined) undoable++;
    if (oldest === null || entry.at < oldest) oldest = entry.at;
  }
  const info: McpAuditSelectionInfo = {
    total: entries.length,
    undoable,
    oldest,
  };
  if (view)
    info.view = viewOf(all, new Set(entries.map((entry) => entry.id)), view);
  return info;
}
