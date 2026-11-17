import { describe, expect, it } from 'vitest';
import { registerMcpIpc, type McpIpcDeps } from '../src/main/ipc/mcp-ipc.js';
import type { McpState } from '../src/ipc-contract/mcp-api.js';
import { recordingIpc } from './helpers/main-fakes.js';

const STATE: McpState = {
  settings: { enabled: true, transport: 'stdio', auditRetentionDays: 30 },
  clients: [],
  connectCommand: {
    claudeCode: '',
    claudeDesktopJson: '',
    cursorJson: '',
    opencodeJson: '',
    codexToml: '',
    generic: '',
  },
  listening: true,
  error: null,
};

function harness() {
  const calls: unknown[][] = [];
  const record =
    <T>(name: string, answer: T) =>
    (...args: unknown[]): T => {
      calls.push([name, ...args]);
      return answer;
    };
  const mutation = { ok: true as const, state: STATE };
  const mcp: McpIpcDeps['mcp'] = {
    state: record('state', STATE),
    setEnabled: record('setEnabled', Promise.resolve(STATE)),
    approve: record('approve', mutation),
    reject: record('reject', mutation),
    update: record('update', mutation),
    revoke: record('revoke', mutation),
    queryAudit: record('queryAudit', {
      entries: [],
      total: 0,
      retained: 0,
      facets: { clients: [], tools: [], results: [] },
      retentionDays: 30,
    }),
    undo: record('undo', Promise.resolve({ ok: true as const })),
    auditSelectionInfo: record('auditSelectionInfo', {
      total: 0,
      undoable: 0,
      oldest: null,
    }),
    deleteAudit: record('deleteAudit', { deleted: 0 }),
    undoMany: record('undoMany', Promise.resolve({ undone: 0, failed: 0 })),
    setAuditRetention: record('setAuditRetention', { days: 7, deleted: 0 }),
    answerConfirm: record('answerConfirm', { ok: true as const }),
    listConfirms: record('listConfirms', []),
  };
  const ipc = recordingIpc();
  registerMcpIpc(ipc, { mcp });
  return { ipc, calls };
}

describe('src/main/ipc/mcp-ipc.ts', () => {
  it.each<[string, unknown, unknown[]]>([
    ['mcp:getState', undefined, ['state']],
    ['mcp:setEnabled', { enabled: true }, ['setEnabled', true]],
    [
      'mcp:approveClient',
      { id: 'c1', scopes: { config: true, root: true } },
      ['approve', 'c1', { config: true }],
    ],
    ['mcp:approveClient', { id: 'c1' }, ['approve', 'c1', undefined]],
    ['mcp:rejectClient', { id: 'c1' }, ['reject', 'c1']],
    [
      'mcp:updateClient',
      { id: 'c1', patch: { redactSecrets: false } },
      ['update', 'c1', { redactSecrets: false }],
    ],
    ['mcp:revokeClient', { id: 'c1' }, ['revoke', 'c1']],
    [
      'mcp:queryAudit',
      { offset: 0, limit: 10, results: ['rejected'], secret: 1 },
      ['queryAudit', { offset: 0, limit: 10, results: ['rejected'] }],
    ],
    ['mcp:undo', { undoToken: 'u1' }, ['undo', 'u1']],
    [
      'mcp:auditSelectionInfo',
      { selection: { kind: 'ids', ids: ['a1'], extra: 1 } },
      ['auditSelectionInfo', { kind: 'ids', ids: ['a1'] }, undefined],
    ],
    [
      'mcp:auditSelectionInfo',
      {
        selection: { kind: 'all' },
        view: { offset: 50, limit: 50, search: 'x', secret: true },
      },
      [
        'auditSelectionInfo',
        { kind: 'all' },
        { offset: 50, limit: 50, search: 'x' },
      ],
    ],
    [
      'mcp:deleteAudit',
      {
        selection: {
          kind: 'query',
          query: { tools: ['restart'], offset: 0 },
          except: ['a2'],
        },
      },
      [
        'deleteAudit',
        { kind: 'query', query: { tools: ['restart'] }, except: ['a2'] },
      ],
    ],
    [
      'mcp:undoChanges',
      { selection: { kind: 'range', from: 1, to: 2 } },
      ['undoMany', { kind: 'range', from: 1, to: 2 }],
    ],
    ['mcp:setAuditRetention', { days: 7 }, ['setAuditRetention', 7]],
    [
      'mcp:answerConfirm',
      { id: 'r1', answer: 'reject' },
      ['answerConfirm', 'r1', 'reject'],
    ],
    ['mcp:listConfirms', undefined, ['listConfirms']],
  ])('%s narrows %j before it acts', (channel, payload, call) => {
    const h = harness();

    void h.ipc.invoke(channel, payload);

    expect(h.calls).toEqual([call]);
  });

  it.each<[string, unknown]>([
    ['mcp:setEnabled', { enabled: 'yes' }],
    ['mcp:approveClient', { id: 'c1', scopes: { read: 1 } }],
    ['mcp:rejectClient', {}],
    ['mcp:updateClient', { id: 'c1', patch: { groups: 'some' } }],
    ['mcp:queryAudit', { limit: 10 }],
    ['mcp:undo', { undoToken: 7 }],
    ['mcp:auditSelectionInfo', { selection: { kind: 'some' } }],
    ['mcp:auditSelectionInfo', { selection: { kind: 'all' }, view: {} }],
    ['mcp:deleteAudit', { selection: { kind: 'ids', ids: [''] } }],
    ['mcp:deleteAudit', {}],
    ['mcp:undoChanges', { selection: { kind: 'query' } }],
    ['mcp:setAuditRetention', { days: 0 }],
    ['mcp:setAuditRetention', { days: 366 }],
    ['mcp:setAuditRetention', { days: 2.5 }],
    ['mcp:answerConfirm', { id: 'r1', answer: 'yes' }],
  ])('%s refuses %j without acting', (channel, payload) => {
    const h = harness();

    expect(() => h.ipc.invoke(channel, payload)).toThrow(TypeError);
    expect(h.calls).toEqual([]);
  });
});
