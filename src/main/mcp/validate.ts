import type {
  McpAuditFilter,
  McpAuditQuery,
  McpClientPatch,
  McpConfirmAnswer,
  McpConfirmPolicy,
  McpScopes,
} from '../../ipc-contract/mcp-api.js';
import { ipcRecord, ipcString, type UnknownRecord } from '../ipc-validators.js';

/**
 * Payload narrowing for the `mcp:*` IPC channels. A renderer is untrusted
 * input like any other: every field is checked for its type and range here,
 * and an unknown key is dropped, before src/main/mcp acts on it.
 */

const SCOPE_KEYS = ['read', 'control', 'workflows', 'config'] as const;
const POLICIES: readonly McpConfirmPolicy[] = ['never', 'first', 'always'];
const FILTERS: readonly McpAuditFilter[] = ['all', 'changes', 'rejected'];
const MAX_GROUP_IDS = 500;
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;

function optionalRecord(value: unknown, label: string): UnknownRecord | null {
  if (value === undefined || value === null) return null;
  return ipcRecord(value, label);
}

export function ipcMcpId(value: unknown, label = 'id'): string {
  const id = ipcString(value, label);
  if (!id || id.length > MAX_ID_LENGTH)
    throw new TypeError(`Invalid IPC ${label}`);
  return id;
}

export function ipcMcpScopes(value: unknown): Partial<McpScopes> | undefined {
  const raw = optionalRecord(value, 'scopes');
  if (!raw) return undefined;
  const scopes: Partial<McpScopes> = {};
  for (const key of SCOPE_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean')
      throw new TypeError(`Invalid IPC scopes.${key}`);
    scopes[key] = raw[key];
  }
  return scopes;
}

function policyField(value: unknown, label: string): McpConfirmPolicy {
  if (!POLICIES.includes(value as McpConfirmPolicy))
    throw new TypeError(`Invalid IPC ${label}`);
  return value as McpConfirmPolicy;
}

function groupsField(value: unknown): 'all' | string[] {
  if (value === 'all') return 'all';
  if (
    !Array.isArray(value) ||
    value.length > MAX_GROUP_IDS ||
    !value.every(
      (id: unknown) =>
        typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH,
    )
  )
    throw new TypeError('Invalid IPC groups');
  return [...(value as string[])];
}

export function ipcMcpClientPatch(value: unknown): McpClientPatch {
  const raw = ipcRecord(value, 'client patch');
  const patch: McpClientPatch = {};
  if (raw.name !== undefined) {
    const name = ipcString(raw.name, 'name');
    if (name.length > MAX_NAME_LENGTH) throw new TypeError('Invalid IPC name');
    patch.name = name;
  }
  const scopes = ipcMcpScopes(raw.scopes);
  if (scopes) patch.scopes = scopes;
  const confirm = optionalRecord(raw.confirm, 'confirm');
  if (confirm) {
    patch.confirm = {};
    if (confirm.control !== undefined)
      patch.confirm.control = policyField(confirm.control, 'confirm.control');
    if (confirm.workflows !== undefined)
      patch.confirm.workflows = policyField(
        confirm.workflows,
        'confirm.workflows',
      );
  }
  if (raw.groups !== undefined) patch.groups = groupsField(raw.groups);
  if (raw.redactSecrets !== undefined) {
    if (typeof raw.redactSecrets !== 'boolean')
      throw new TypeError('Invalid IPC redactSecrets');
    patch.redactSecrets = raw.redactSecrets;
  }
  return patch;
}

export function ipcMcpAuditQuery(value: unknown): McpAuditQuery {
  const raw = ipcRecord(value, 'audit query');
  const limit = raw.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw new TypeError('Invalid IPC limit');
  const query: McpAuditQuery = { limit };
  if (raw.clientId !== undefined)
    query.clientId = ipcMcpId(raw.clientId, 'clientId');
  if (raw.filter !== undefined) {
    if (!FILTERS.includes(raw.filter as McpAuditFilter))
      throw new TypeError('Invalid IPC filter');
    query.filter = raw.filter as McpAuditFilter;
  }
  return query;
}

export function ipcMcpConfirmAnswer(value: unknown): McpConfirmAnswer {
  if (value !== 'apply' && value !== 'reject')
    throw new TypeError('Invalid IPC confirm answer');
  return value;
}
