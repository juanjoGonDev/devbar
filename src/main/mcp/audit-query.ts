import type {
  McpAuditEntry,
  McpAuditFacets,
  McpAuditFilter,
  McpAuditPage,
  McpAuditPageQuery,
  McpAuditResult,
  McpAuditSort,
  McpAuditSortKey,
  McpScopeKey,
} from '../../ipc-contract/mcp-api.js';
import { auditResultLabel } from '../../mcp-audit-labels.js';

/**
 * One page of the audit log for «Actividad»: the entries that match the
 * query, sorted by its keys, sliced to the page, plus the counts each column
 * filter shows. Pure over the entries the log holds, so the log stays the
 * only thing that knows about the file.
 */

/** What the counts list even when no entry has them. */
export interface AuditKnown {
  /** The clients the store knows, in its order. */
  clients: readonly { id: string; name: string }[];
  /** The tool catalog, in its order. */
  tools: readonly { name: string; scope: McpScopeKey }[];
}

/** The columns a facet leaves its own filter out for. */
type FacetColumn = 'client' | 'action' | 'result';

const RESULTS: readonly McpAuditResult[] = [
  'ok',
  'warning',
  'error',
  'rejected',
  'pending',
];
const RANK = new Map(RESULTS.map((result, index) => [result, index]));
const MAX_LIMIT = 100;

const collator = new Intl.Collator('es', {
  sensitivity: 'base',
  numeric: true,
});

const COMPARE: Readonly<
  Record<McpAuditSortKey, (a: McpAuditEntry, b: McpAuditEntry) => number>
> = {
  time: (a, b) => a.at - b.at,
  client: (a, b) => collator.compare(a.clientName, b.clientName),
  action: (a, b) =>
    collator.compare(a.tool, b.tool) || collator.compare(a.target, b.target),
  result: (a, b) => (RANK.get(a.result) ?? 0) - (RANK.get(b.result) ?? 0),
};

const NEWEST_FIRST: readonly McpAuditSort[] = [{ key: 'time', dir: 'desc' }];

interface Prepared {
  search: string;
  clients: ReadonlySet<string> | null;
  tools: ReadonlySet<string> | null;
  results: ReadonlySet<McpAuditResult> | null;
  undoable: boolean;
  from: number;
  to: number;
}

const setOf = <T>(list: readonly T[] | undefined): ReadonlySet<T> | null =>
  list ? new Set(list) : null;

function prepare(query: McpAuditFilter): Prepared {
  return {
    search: (query.search ?? '').trim().toLowerCase(),
    clients: setOf(query.clientIds),
    tools: setOf(query.tools),
    results: setOf(query.results),
    undoable: query.undoable === true,
    from: query.from ?? -Infinity,
    to: query.to ?? Infinity,
  };
}

/** The text the search looks in, one field per line so none run together. */
const haystacks = new WeakMap<McpAuditEntry, string>();
function haystack(entry: McpAuditEntry): string {
  let text = haystacks.get(entry);
  if (text === undefined) {
    text = [
      entry.tool,
      entry.target,
      entry.summary,
      entry.clientName,
      auditResultLabel(entry),
    ]
      .join('\n')
      .toLowerCase();
    haystacks.set(entry, text);
  }
  return text;
}

function matches(
  entry: McpAuditEntry,
  p: Prepared,
  except?: FacetColumn,
): boolean {
  if (entry.at < p.from || entry.at > p.to) return false;
  if (except !== 'client' && p.clients && !p.clients.has(entry.clientId))
    return false;
  if (except !== 'action' && p.tools && !p.tools.has(entry.tool)) return false;
  if (except !== 'result') {
    if (p.results && !p.results.has(entry.result)) return false;
    if (p.undoable && entry.undoToken === undefined) return false;
  }
  return !p.search || haystack(entry).includes(p.search);
}

function comparator(
  sort: readonly McpAuditSort[] | undefined,
): (a: McpAuditEntry, b: McpAuditEntry) => number {
  const keys = sort && sort.length > 0 ? sort : NEWEST_FIRST;
  return (a, b) => {
    for (const { key, dir } of keys) {
      const order = COMPARE[key](a, b);
      if (order !== 0) return dir === 'asc' ? order : -order;
    }
    // Ties read newest first, and never depend on the order of the file.
    return b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}

function countBy<T>(
  entries: readonly McpAuditEntry[],
  p: Prepared,
  except: FacetColumn,
  keyOf: (entry: McpAuditEntry) => T,
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const entry of entries)
    if (matches(entry, p, except)) {
      const key = keyOf(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return counts;
}

/** Known values first (in their order), then the rest by name. */
function ordered(known: readonly string[], seen: Iterable<string>): string[] {
  const listed = new Set(known);
  const rest = [...new Set(seen)]
    .filter((value) => !listed.has(value))
    .sort((a, b) => collator.compare(a, b));
  return [...known, ...rest];
}

function clientFacet(
  entries: readonly McpAuditEntry[],
  p: Prepared,
  known: AuditKnown,
): McpAuditFacets['clients'] {
  const counts = countBy(entries, p, 'client', (entry) => entry.clientId);
  // A client the store no longer has goes by the name of its newest entry.
  const newest = new Map<string, McpAuditEntry>();
  for (const entry of entries) {
    const seen = newest.get(entry.clientId);
    if (!seen || entry.at >= seen.at) newest.set(entry.clientId, entry);
  }
  const names = new Map(
    [...newest].map(([id, entry]) => [id, entry.clientName]),
  );
  for (const client of known.clients) names.set(client.id, client.name);
  const ids = ordered(
    known.clients.map((client) => client.id),
    [...entries.map((entry) => entry.clientId), ...(p.clients ?? [])],
  );
  return ids.map((id) => ({
    id,
    name: names.get(id) ?? id,
    count: counts.get(id) ?? 0,
  }));
}

function toolFacet(
  entries: readonly McpAuditEntry[],
  p: Prepared,
  known: AuditKnown,
): McpAuditFacets['tools'] {
  const counts = countBy(entries, p, 'action', (entry) => entry.tool);
  const family = new Map(known.tools.map((tool) => [tool.name, tool.scope]));
  const names = ordered(
    known.tools.map((tool) => tool.name),
    [...entries.map((entry) => entry.tool), ...(p.tools ?? [])],
  );
  return names.map((tool) => ({
    tool,
    family: family.get(tool) ?? null,
    count: counts.get(tool) ?? 0,
  }));
}

/** The entries a filter matches, in the log's own order. */
export function filterAuditEntries(
  all: readonly McpAuditEntry[],
  filter: McpAuditFilter,
): McpAuditEntry[] {
  const p = prepare(filter);
  return all.filter((entry) => matches(entry, p));
}

/** Where a page query puts each entry: its match, sorted, and the slice. */
export function paged(
  all: readonly McpAuditEntry[],
  query: McpAuditPageQuery,
): { matching: McpAuditEntry[]; offset: number; limit: number } {
  const matching = filterAuditEntries(all, query);
  matching.sort(comparator(query.sort));
  return {
    matching,
    limit: Math.max(1, Math.min(MAX_LIMIT, Math.floor(query.limit))),
    offset: Math.max(0, Math.floor(query.offset)),
  };
}

export function queryAuditEntries(
  all: readonly McpAuditEntry[],
  query: McpAuditPageQuery,
  known: AuditKnown,
): Omit<McpAuditPage, 'retentionDays'> {
  const p = prepare(query);
  const { matching, offset, limit } = paged(all, query);
  const results = countBy(all, p, 'result', (entry) => entry.result);
  return {
    entries: matching
      .slice(offset, offset + limit)
      .map((entry) => structuredClone(entry)),
    total: matching.length,
    retained: all.length,
    facets: {
      clients: clientFacet(all, p, known),
      tools: toolFacet(all, p, known),
      results: RESULTS.map((result) => ({
        result,
        count: results.get(result) ?? 0,
      })),
    },
  };
}
