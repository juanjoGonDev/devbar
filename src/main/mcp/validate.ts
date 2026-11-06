import type {
  McpAuditFilter,
  McpAuditPageQuery,
  McpAuditResult,
  McpAuditSelection,
  McpAuditSort,
  McpClientPatch,
  McpConfirmAnswer,
  McpConfirmPolicy,
  McpScopes,
} from '../../ipc-contract/mcp-api.js';
import {
  ipcNumber,
  ipcRecord,
  ipcString,
  type UnknownRecord,
} from '../ipc-validators.js';
import { AUDIT_RETENTION_DAYS } from '../../mcp-audit-labels.js';

/**
 * Payload narrowing for the `mcp:*` IPC channels. A renderer is untrusted
 * input like any other: every field is checked for its type and range here,
 * and an unknown key is dropped, before src/main/mcp acts on it.
 */

const SCOPE_KEYS = ['read', 'control', 'workflows', 'config'] as const;
const POLICIES: readonly McpConfirmPolicy[] = ['never', 'first', 'always'];
const RESULTS: readonly McpAuditResult[] = [
  'ok',
  'warning',
  'error',
  'rejected',
  'pending',
];
const SORT_KEYS: readonly McpAuditSort['key'][] = [
  'time',
  'client',
  'action',
  'result',
];
const MAX_AUDIT_LIMIT = 100;
const MAX_SEARCH_LENGTH = 200;
const MAX_FILTER_VALUES = 500;
const MAX_TOOL_LENGTH = 100;
const MAX_GROUP_IDS = 500;
const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
/** Ids ticked one by one, across pages: far more than anyone clicks. */
const MAX_SELECTED_IDS = 10_000;

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
    if (confirm.config !== undefined)
      patch.confirm.config = policyField(confirm.config, 'confirm.config');
  }
  if (raw.groups !== undefined) patch.groups = groupsField(raw.groups);
  if (raw.redactSecrets !== undefined) {
    if (typeof raw.redactSecrets !== 'boolean')
      throw new TypeError('Invalid IPC redactSecrets');
    patch.redactSecrets = raw.redactSecrets;
  }
  return patch;
}

function idList(
  value: unknown,
  label: string,
  maxLength: number,
  maxCount = MAX_FILTER_VALUES,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxCount ||
    !value.every(
      (id: unknown) =>
        typeof id === 'string' && id.length > 0 && id.length <= maxLength,
    )
  )
    throw new TypeError(`Invalid IPC ${label}`);
  return [...new Set(value as string[])];
}

function resultList(value: unknown): McpAuditResult[] {
  if (
    !Array.isArray(value) ||
    !value.every((result) => RESULTS.includes(result as McpAuditResult))
  )
    throw new TypeError('Invalid IPC results');
  return [...new Set(value as McpAuditResult[])];
}

function sortList(value: unknown): McpAuditSort[] {
  if (!Array.isArray(value) || value.length > SORT_KEYS.length)
    throw new TypeError('Invalid IPC sort');
  const sort: McpAuditSort[] = [];
  for (const item of value) {
    const raw = ipcRecord(item, 'sort');
    const key = raw.key as McpAuditSort['key'];
    if (!SORT_KEYS.includes(key) || (raw.dir !== 'asc' && raw.dir !== 'desc'))
      throw new TypeError('Invalid IPC sort');
    if (sort.some((each) => each.key === key))
      throw new TypeError('Invalid IPC sort: repeated key');
    sort.push({ key, dir: raw.dir });
  }
  return sort;
}

function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError(`Invalid IPC ${label}`);
  return value;
}

/** What narrows the activity log: sizes capped, keys and values whitelisted. */
function auditFilter(raw: UnknownRecord): McpAuditFilter {
  const filter: McpAuditFilter = {};
  if (raw.search !== undefined) {
    const search = ipcString(raw.search, 'search');
    if (search.length > MAX_SEARCH_LENGTH)
      throw new TypeError('Invalid IPC search');
    filter.search = search;
  }
  if (raw.clientIds !== undefined)
    filter.clientIds = idList(raw.clientIds, 'clientIds', MAX_ID_LENGTH);
  if (raw.tools !== undefined)
    filter.tools = idList(raw.tools, 'tools', MAX_TOOL_LENGTH);
  if (raw.results !== undefined) filter.results = resultList(raw.results);
  if (raw.undoable !== undefined) {
    if (typeof raw.undoable !== 'boolean')
      throw new TypeError('Invalid IPC undoable');
    filter.undoable = raw.undoable;
  }
  if (raw.from !== undefined) filter.from = ipcNumber(raw.from, 'from');
  if (raw.to !== undefined) filter.to = ipcNumber(raw.to, 'to');
  return filter;
}

/** One page of the activity log: sizes capped, keys and values whitelisted. */
export function ipcMcpAuditPageQuery(value: unknown): McpAuditPageQuery {
  const raw = ipcRecord(value, 'audit query');
  const offset = wholeNumber(raw.offset, 'offset');
  if (offset < 0) throw new TypeError('Invalid IPC offset');
  const limit = Math.min(
    MAX_AUDIT_LIMIT,
    Math.max(1, wholeNumber(raw.limit, 'limit')),
  );
  const query: McpAuditPageQuery = { offset, limit, ...auditFilter(raw) };
  if (raw.sort !== undefined) query.sort = sortList(raw.sort);
  return query;
}

const selectedIds = (value: unknown, label: string): string[] =>
  idList(value, label, MAX_ID_LENGTH, MAX_SELECTED_IDS);

/** Entries picked in «Actividad»: one of four shapes, each one bounded. */
export function ipcMcpAuditSelection(value: unknown): McpAuditSelection {
  const raw = ipcRecord(value, 'audit selection');
  switch (raw.kind) {
    case 'all':
      return { kind: 'all' };
    case 'ids':
      return { kind: 'ids', ids: selectedIds(raw.ids, 'ids') };
    case 'range': {
      const range: Extract<McpAuditSelection, { kind: 'range' }> = {
        kind: 'range',
      };
      if (raw.from !== undefined) range.from = ipcNumber(raw.from, 'from');
      if (raw.to !== undefined) range.to = ipcNumber(raw.to, 'to');
      return range;
    }
    case 'query': {
      const picked: Extract<McpAuditSelection, { kind: 'query' }> = {
        kind: 'query',
        query: auditFilter(ipcRecord(raw.query, 'audit selection query')),
      };
      if (raw.except !== undefined)
        picked.except = selectedIds(raw.except, 'except');
      if (raw.include !== undefined)
        picked.include = selectedIds(raw.include, 'include');
      return picked;
    }
    default:
      throw new TypeError('Invalid IPC audit selection');
  }
}

/** «Borrado automático»: a whole number of days within range. */
export function ipcMcpRetentionDays(value: unknown): number {
  const days = wholeNumber(value, 'days');
  if (days < AUDIT_RETENTION_DAYS.min || days > AUDIT_RETENTION_DAYS.max)
    throw new TypeError('Invalid IPC days');
  return days;
}

export function ipcMcpConfirmAnswer(value: unknown): McpConfirmAnswer {
  if (value !== 'apply' && value !== 'reject')
    throw new TypeError('Invalid IPC confirm answer');
  return value;
}
