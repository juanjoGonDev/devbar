import type {
  McpClient,
  McpClientKind,
  McpClientPatch,
  McpConfirmPolicy,
  McpScopes,
} from '../../ipc-contract/mcp-api.js';

/**
 * The AI assistants that connected to DevBar over MCP, and what each one may
 * do. An assistant is recognised by the name it announces in the MCP
 * `initialize` handshake (`clientInfo.name`): the first time it is seen it is
 * stored as `pending`, and it only gets real tools once the user approves it
 * in Settings › MCP.
 *
 * The records are held in memory and written through `write`; the usage
 * counters (last use, calls today) change on every tool call, so those writes
 * are coalesced behind a short timer instead of rewriting the config file per
 * call. A status or permission change is written at once.
 */

/** What is persisted: the view plus the matching key and the counter's day. */
export interface McpClientRecord extends McpClient {
  /** The lowercased `clientInfo.name` this record is matched by. */
  key: string;
  /** Local day (YYYY-MM-DD) `callsToday` counts for. */
  callsDay: string;
}

/** What an assistant says about itself in `initialize`. */
export interface McpClientInfo {
  name: string;
  version?: string | undefined;
  title?: string | undefined;
}

export interface ClientStoreDeps {
  read(): unknown;
  write(records: readonly McpClientRecord[]): void;
  now(): number;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type ClientStoreResult =
  { ok: true; client: McpClient } | { ok: false; error: string };

export interface ClientStore {
  list(): McpClient[];
  get(id: string): McpClient | null;
  /** The client behind this handshake, created `pending` the first time. */
  identify(info: McpClientInfo): McpClient;
  approve(id: string, scopes?: Partial<McpScopes>): ClientStoreResult;
  reject(id: string): ClientStoreResult;
  revoke(id: string): ClientStoreResult;
  update(id: string, patch: McpClientPatch): ClientStoreResult;
  /** One more tool call: bumps `lastUsedAt` and `callsToday`. */
  recordCall(id: string): void;
  /** Writes any coalesced usage now (quit, tests). */
  flush(): void;
  /** Status or permissions changed: live sessions re-check their tools. */
  onChange(listener: (client: McpClient) => void): void;
}

/** How long usage counters wait before they are written. */
export const USAGE_FLUSH_MS = 5000;
const MAX_NAME_LENGTH = 80;
const MAX_KEY_LENGTH = 200;

const DEFAULT_MCP_SCOPES: McpScopes = {
  read: true,
  control: true,
  workflows: true,
  config: false,
};

const NOT_FOUND = 'Ese cliente MCP ya no existe';

/** Which assistant announced itself, from its `clientInfo.name`. */
export function clientKind(name: string): McpClientKind {
  const lower = name.toLowerCase();
  if (lower.includes('claude-code') || lower.includes('claude code'))
    return 'claude-code';
  if (lower.includes('claude')) return 'claude-desktop';
  if (lower.includes('cursor')) return 'cursor';
  return 'other';
}

const KIND_NAMES: Record<Exclude<McpClientKind, 'other'>, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
};

/** The name Settings shows for a new client. */
export function displayName(info: McpClientInfo): string {
  const kind = clientKind(info.name);
  if (kind !== 'other') return KIND_NAMES[kind];
  const title = info.title?.trim();
  return cleanName(title || info.name) || 'Cliente MCP';
}

function cleanName(value: string): string {
  return value.trim().slice(0, MAX_NAME_LENGTH);
}

/** Local calendar day of `ms`, the unit `callsToday` resets on. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const POLICIES: readonly McpConfirmPolicy[] = ['never', 'first', 'always'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
function policy(value: unknown, fallback: McpConfirmPolicy): McpConfirmPolicy {
  return POLICIES.includes(value as McpConfirmPolicy)
    ? (value as McpConfirmPolicy)
    : fallback;
}
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeScopes(value: unknown, base: McpScopes): McpScopes {
  const raw = isRecord(value) ? value : {};
  return {
    read: bool(raw.read, base.read),
    control: bool(raw.control, base.control),
    workflows: bool(raw.workflows, base.workflows),
    config: bool(raw.config, base.config),
  };
}

function normalizeGroups(value: unknown): 'all' | string[] {
  if (!Array.isArray(value)) return 'all';
  return [
    ...new Set(value.filter((id): id is string => typeof id === 'string')),
  ];
}

/** One stored record, or null when it cannot be one. Total. */
export function normalizeClientRecord(value: unknown): McpClientRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.key !== 'string' || !value.key) return null;
  const status =
    value.status === 'allowed' || value.status === 'revoked'
      ? value.status
      : 'pending';
  const confirm = isRecord(value.confirm) ? value.confirm : {};
  const kind = clientKind(value.key);
  const name =
    typeof value.name === 'string' && value.name.trim()
      ? cleanName(value.name)
      : displayName({ name: value.key });
  return {
    id: value.id,
    key: value.key.slice(0, MAX_KEY_LENGTH),
    name,
    kind,
    status,
    createdAt: finite(value.createdAt, 0),
    lastUsedAt:
      typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt)
        ? value.lastUsedAt
        : null,
    callsToday: Math.max(0, Math.floor(finite(value.callsToday, 0))),
    callsDay: typeof value.callsDay === 'string' ? value.callsDay : '',
    scopes: normalizeScopes(value.scopes, DEFAULT_MCP_SCOPES),
    confirm: {
      control: policy(confirm.control, 'never'),
      workflows: policy(confirm.workflows, 'first'),
      config: 'always',
    },
    groups: normalizeGroups(value.groups),
    redactSecrets: bool(value.redactSecrets, true),
  };
}

export function createClientStore(deps: ClientStoreDeps): ClientStore {
  const raw = deps.read();
  const records: McpClientRecord[] = (Array.isArray(raw) ? raw : [])
    .map(normalizeClientRecord)
    .filter((record): record is McpClientRecord => record !== null);
  const listeners: ((client: McpClient) => void)[] = [];
  let pendingWrite: unknown = null;

  const view = (record: McpClientRecord): McpClient => {
    const { key: _key, callsDay, ...client } = record;
    const today = localDay(deps.now());
    return {
      ...structuredClone(client),
      callsToday: callsDay === today ? client.callsToday : 0,
    };
  };
  const find = (id: string): McpClientRecord | undefined =>
    records.find((record) => record.id === id);

  const writeNow = (): void => {
    if (pendingWrite !== null) {
      deps.clearTimer(pendingWrite);
      pendingWrite = null;
    }
    deps.write(records.map((record) => structuredClone(record)));
  };
  const writeSoon = (): void => {
    if (pendingWrite !== null) return;
    pendingWrite = deps.setTimer(() => {
      pendingWrite = null;
      deps.write(records.map((record) => structuredClone(record)));
    }, USAGE_FLUSH_MS);
  };
  const changed = (record: McpClientRecord): ClientStoreResult => {
    writeNow();
    const client = view(record);
    for (const listener of listeners) listener(client);
    return { ok: true, client };
  };
  const withRecord = (
    id: string,
    mutate: (record: McpClientRecord) => string | null,
  ): ClientStoreResult => {
    const record = find(id);
    if (!record) return { ok: false, error: NOT_FOUND };
    const refusal = mutate(record);
    if (refusal) return { ok: false, error: refusal };
    return changed(record);
  };

  return {
    list: () => records.map(view),
    get: (id) => {
      const record = find(id);
      return record ? view(record) : null;
    },
    identify: (info) => {
      const key = info.name.trim().toLowerCase().slice(0, MAX_KEY_LENGTH);
      const existing = records.find((record) => record.key === key);
      if (existing) return view(existing);
      const now = deps.now();
      const record: McpClientRecord = {
        id: deps.newId(),
        key,
        name: displayName(info),
        kind: clientKind(key),
        status: 'pending',
        createdAt: now,
        lastUsedAt: now,
        callsToday: 0,
        callsDay: localDay(now),
        scopes: { ...DEFAULT_MCP_SCOPES },
        confirm: { control: 'never', workflows: 'first', config: 'always' },
        groups: 'all',
        redactSecrets: true,
      };
      records.push(record);
      changed(record);
      return view(record);
    },
    approve: (id, scopes) =>
      withRecord(id, (record) => {
        record.status = 'allowed';
        record.scopes = normalizeScopes(scopes, record.scopes);
        return null;
      }),
    reject: (id) =>
      withRecord(id, (record) => {
        if (record.status !== 'pending')
          return 'Solo se puede rechazar un cliente pendiente';
        record.status = 'revoked';
        return null;
      }),
    revoke: (id) =>
      withRecord(id, (record) => {
        record.status = 'revoked';
        return null;
      }),
    update: (id, patch) =>
      withRecord(id, (record) => {
        if (patch.name !== undefined) {
          const name = cleanName(patch.name);
          if (!name) return 'El nombre no puede estar vacío';
          record.name = name;
        }
        if (patch.scopes)
          record.scopes = normalizeScopes(patch.scopes, record.scopes);
        if (patch.confirm) {
          record.confirm = {
            control: policy(patch.confirm.control, record.confirm.control),
            workflows: policy(
              patch.confirm.workflows,
              record.confirm.workflows,
            ),
            config: 'always',
          };
        }
        if (patch.groups !== undefined)
          record.groups = normalizeGroups(patch.groups);
        if (patch.redactSecrets !== undefined)
          record.redactSecrets = patch.redactSecrets;
        return null;
      }),
    recordCall: (id) => {
      const record = find(id);
      if (!record) return;
      const now = deps.now();
      const today = localDay(now);
      record.callsToday = record.callsDay === today ? record.callsToday + 1 : 1;
      record.callsDay = today;
      record.lastUsedAt = now;
      writeSoon();
    },
    flush: () => {
      if (pendingWrite !== null) writeNow();
    },
    onChange: (listener) => {
      listeners.push(listener);
    },
  };
}
