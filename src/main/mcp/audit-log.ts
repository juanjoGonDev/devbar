import type {
  McpAuditEntry,
  McpAuditPage,
  McpAuditPageQuery,
  McpAuditSelection,
  McpAuditSelectionInfo,
} from '../../ipc-contract/mcp-api.js';
import { DAY_MS } from '../../mcp-audit-labels.js';
import { queryAuditEntries, type AuditKnown } from './audit-query.js';
import { resolveSelection, selectionInfo } from './audit-selection.js';

/**
 * Every MCP tool call, kept in its own file (one JSON entry per line) for
 * the days the user chose (30 unless told otherwise). Reads are summarised in
 * one line; the log lines an assistant read are never copied here. An entry
 * is appended once and may be appended again under the same id when it
 * settles (a confirmation answered, an undo used): the last line wins when
 * the file is read back. Deleting entries, by hand or by age, rewrites the
 * file whole and tells the windows to read the log again.
 *
 * Kept out of the config file on purpose: it grows with every call, and the
 * config file is rewritten whole on every save.
 */

const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 500;

/** The newest entries, optionally of one client (main's own reads). */
interface AuditListQuery {
  clientId?: string;
  /** At most this many (1–500). */
  limit: number;
}

export interface AuditLogDeps {
  /** The file as it is on disk, or null when there is none yet. */
  load(): string | null;
  append(line: string): void;
  /** Replaces the whole file (pruning, deleting). */
  rewrite(content: string): void;
  now(): number;
  newId(): string;
  /** How many days an entry is kept (read at every prune). */
  retentionDays(): number;
  /** A new or settled entry, for the windows. */
  published(entry: McpAuditEntry): void;
  /** Entries left the log: the windows read it again. */
  refreshed(): void;
}

export type AuditDraft = Omit<McpAuditEntry, 'id' | 'at'>;
/** A settlement: `undefined` drops the field (an undo token once used). */
type AuditPatch = {
  [K in keyof AuditDraft]?: AuditDraft[K] | undefined;
};

export interface AuditLog {
  record(draft: AuditDraft): McpAuditEntry;
  /** Settles an entry (`pending` → `ok`…) or drops its undo token. */
  update(id: string, patch: AuditPatch): McpAuditEntry | null;
  list(query: AuditListQuery): McpAuditEntry[];
  /** One page of «Actividad»: filtered, sorted, sliced and counted. */
  query(query: McpAuditPageQuery, known: AuditKnown): McpAuditPage;
  /** The entry an undo token belongs to, while it still can be undone. */
  byUndoToken(token: string): McpAuditEntry | null;
  /** This client's newest change that can still be undone. */
  latestUndoable(clientId: string): McpAuditEntry | null;
  /** How many entries a selection holds (and where, in a page query). */
  selectionInfo(
    selection: McpAuditSelection,
    view?: McpAuditPageQuery,
  ): McpAuditSelectionInfo;
  /** Deletes the selected entries; answers how many went. */
  remove(selection: McpAuditSelection): number;
  /** The selected changes that can still be undone, newest first. */
  undoableIn(selection: McpAuditSelection): McpAuditEntry[];
  /** Drops what is older than the retention now; answers how many went. */
  prune(): number;
}

function parseEntry(line: string): McpAuditEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object') return null;
    const entry = value as McpAuditEntry;
    if (typeof entry.id !== 'string' || typeof entry.at !== 'number')
      return null;
    return entry;
  } catch {
    return null;
  }
}

export function createAuditLog(deps: AuditLogDeps): AuditLog {
  const entries = new Map<string, McpAuditEntry>();
  for (const line of (deps.load() ?? '').split('\n')) {
    const entry = line.trim() ? parseEntry(line) : null;
    if (entry) entries.set(entry.id, entry);
  }
  let lastPrune = 0;

  /** Takes these entries out of the file and tells the windows. */
  const drop = (gone: readonly McpAuditEntry[]): number => {
    if (gone.length === 0) return 0;
    for (const entry of gone) entries.delete(entry.id);
    deps.rewrite(
      [...entries.values()]
        .map((entry) => JSON.stringify(entry) + '\n')
        .join(''),
    );
    deps.refreshed();
    return gone.length;
  };

  const prune = (): number => {
    const now = deps.now();
    lastPrune = now;
    const keep = deps.retentionDays() * DAY_MS;
    return drop([...entries.values()].filter((entry) => now - entry.at > keep));
  };
  prune();

  const write = (entry: McpAuditEntry): void => {
    entries.set(entry.id, entry);
    deps.append(JSON.stringify(entry) + '\n');
    deps.published(structuredClone(entry));
    if (deps.now() - lastPrune > PRUNE_EVERY_MS) prune();
  };

  return {
    record: (draft) => {
      const entry: McpAuditEntry = {
        id: deps.newId(),
        at: deps.now(),
        ...draft,
      };
      write(entry);
      return structuredClone(entry);
    },
    update: (id, patch) => {
      const current = entries.get(id);
      if (!current) return null;
      const merged: Record<string, unknown> = { ...current, ...patch };
      for (const key of Object.keys(merged))
        if (merged[key] === undefined) delete merged[key];
      const next = merged as unknown as McpAuditEntry;
      write(next);
      return structuredClone(next);
    },
    list: (query) => {
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(query.limit)));
      return [...entries.values()]
        .filter((entry) => !query.clientId || entry.clientId === query.clientId)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },
    query: (query, known) => ({
      ...queryAuditEntries([...entries.values()], query, known),
      retentionDays: deps.retentionDays(),
    }),
    byUndoToken: (token) => {
      for (const entry of entries.values())
        if (entry.undoToken === token) return structuredClone(entry);
      return null;
    },
    latestUndoable: (clientId) => {
      let latest: McpAuditEntry | null = null;
      for (const entry of entries.values())
        if (
          entry.clientId === clientId &&
          entry.undoToken !== undefined &&
          (!latest || entry.at >= latest.at)
        )
          latest = entry;
      return latest ? structuredClone(latest) : null;
    },
    selectionInfo: (selection, view) =>
      selectionInfo([...entries.values()], selection, view),
    remove: (selection) =>
      drop(resolveSelection([...entries.values()], selection)),
    undoableIn: (selection) =>
      resolveSelection([...entries.values()], selection)
        .filter((entry) => entry.undoToken !== undefined)
        .sort((a, b) => b.at - a.at)
        .map((entry) => structuredClone(entry)),
    prune,
  };
}
