import type {
  McpAuditEntry,
  McpAuditPage,
  McpAuditPageQuery,
} from '../../ipc-contract/mcp-api.js';
import { AUDIT_RETENTION_MS } from '../../mcp-audit-labels.js';
import { queryAuditEntries, type AuditKnown } from './audit-query.js';

/**
 * Every MCP tool call, kept for 30 days in its own file (one JSON entry per
 * line). Reads are summarised in one line; the log lines an assistant read
 * are never copied here. An entry is appended once and may be appended again
 * under the same id when it settles (a confirmation answered, an undo used):
 * the last line wins when the file is read back.
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
  /** Replaces the whole file (pruning). */
  rewrite(content: string): void;
  now(): number;
  newId(): string;
  /** A new or settled entry, for the windows. */
  published(entry: McpAuditEntry): void;
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

  const prune = (): void => {
    const now = deps.now();
    lastPrune = now;
    let dropped = false;
    for (const [id, entry] of entries) {
      if (now - entry.at > AUDIT_RETENTION_MS) {
        entries.delete(id);
        dropped = true;
      }
    }
    if (dropped)
      deps.rewrite(
        [...entries.values()]
          .map((entry) => JSON.stringify(entry) + '\n')
          .join(''),
      );
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
    query: (query, known) =>
      queryAuditEntries([...entries.values()], query, known),
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
  };
}
