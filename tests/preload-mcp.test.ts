import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MCP slice of `src/preload.ts` (Settings › MCP and the confirmation
 * dialog), kept apart from tests/preload.test.ts only for size: the same
 * check that each method maps onto exactly its own IPC channel and payload,
 * and that each subscription hands back nothing but the payload.
 */

const ipc = vi.hoisted(() => ({
  invokes: [] as { channel: string; args: unknown[] }[],
  on: [] as {
    channel: string;
    handler: (event: unknown, payload: unknown) => void;
  }[],
  exposed: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      ipc.exposed.set(key, value);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      ipc.invokes.push({ channel, args });
      return Promise.resolve({ channel });
    },
    on: (
      channel: string,
      handler: (event: unknown, payload: unknown) => void,
    ) => {
      ipc.on.push({ channel, handler });
    },
    removeListener: () => undefined,
  },
}));

import '../src/preload.js';
import type { DevBarApi } from '../src/ipc-contract.js';

function api(): DevBarApi {
  const exposed = ipc.exposed.get('api');
  if (!exposed) throw new Error('preload exposed nothing under "api"');
  return exposed as DevBarApi;
}

const FORWARDS: readonly [
  string,
  (api: DevBarApi) => unknown,
  string,
  readonly unknown[],
][] = [
  ['getMcpState', (a) => a.getMcpState(), 'mcp:getState', []],
  [
    'setMcpEnabled',
    (a) => a.setMcpEnabled(true),
    'mcp:setEnabled',
    [{ enabled: true }],
  ],
  [
    'approveMcpClient',
    (a) => a.approveMcpClient('c1', { config: true }),
    'mcp:approveClient',
    [{ id: 'c1', scopes: { config: true } }],
  ],
  [
    'rejectMcpClient',
    (a) => a.rejectMcpClient('c1'),
    'mcp:rejectClient',
    [{ id: 'c1' }],
  ],
  [
    'updateMcpClient',
    (a) => a.updateMcpClient('c1', { redactSecrets: false }),
    'mcp:updateClient',
    [{ id: 'c1', patch: { redactSecrets: false } }],
  ],
  [
    'revokeMcpClient',
    (a) => a.revokeMcpClient('c1'),
    'mcp:revokeClient',
    [{ id: 'c1' }],
  ],
  [
    'queryMcpAudit',
    (a) => a.queryMcpAudit({ search: 'restart', offset: 50, limit: 50 }),
    'mcp:queryAudit',
    [{ search: 'restart', offset: 50, limit: 50 }],
  ],
  [
    'undoMcpChange',
    (a) => a.undoMcpChange('u1'),
    'mcp:undo',
    [{ undoToken: 'u1' }],
  ],
  [
    'getMcpAuditSelectionInfo',
    (a) => a.getMcpAuditSelectionInfo({ kind: 'all' }, { offset: 0, limit: 5 }),
    'mcp:auditSelectionInfo',
    [{ selection: { kind: 'all' }, view: { offset: 0, limit: 5 } }],
  ],
  [
    'deleteMcpAudit',
    (a) => a.deleteMcpAudit({ kind: 'ids', ids: ['a1'] }),
    'mcp:deleteAudit',
    [{ selection: { kind: 'ids', ids: ['a1'] } }],
  ],
  [
    'undoMcpChanges',
    (a) => a.undoMcpChanges({ kind: 'range', to: 5 }),
    'mcp:undoChanges',
    [{ selection: { kind: 'range', to: 5 } }],
  ],
  [
    'setMcpAuditRetention',
    (a) => a.setMcpAuditRetention(7),
    'mcp:setAuditRetention',
    [{ days: 7 }],
  ],
  [
    'answerMcpConfirm',
    (a) => a.answerMcpConfirm('r1', 'apply'),
    'mcp:answerConfirm',
    [{ id: 'r1', answer: 'apply' }],
  ],
  ['listMcpConfirms', (a) => a.listMcpConfirms(), 'mcp:listConfirms', []],
];

const SUBSCRIPTIONS: readonly [
  string,
  (api: DevBarApi, cb: (payload: unknown) => void) => () => void,
  string,
][] = [
  ['onMcpUpdate', (a, cb) => a.onMcpUpdate(cb), 'mcp:update'],
  [
    'onMcpConfirmRequest',
    (a, cb) => a.onMcpConfirmRequest(cb),
    'mcp:confirmRequest',
  ],
  [
    'onMcpConfirmClosed',
    (a, cb) => a.onMcpConfirmClosed(cb),
    'mcp:confirmClosed',
  ],
  ['onMcpAudit', (a, cb) => a.onMcpAudit(cb), 'mcp:audit'],
];

describe('src/preload.ts (MCP)', () => {
  beforeEach(() => {
    ipc.invokes.length = 0;
    ipc.on.length = 0;
  });

  it.each(FORWARDS)(
    '%s forwards to its own channel with its own payload',
    (_label, call, channel, args) => {
      void call(api());

      expect(ipc.invokes).toEqual([{ channel, args: [...args] }]);
    },
  );

  it.each(SUBSCRIPTIONS)(
    '%s listens on its own channel and hands back only the payload',
    (_label, subscribe, channel) => {
      const seen: unknown[] = [];
      subscribe(api(), (payload) => seen.push(payload));

      expect(ipc.on.map((entry) => entry.channel)).toEqual([channel]);
      ipc.on[0]?.handler({ sender: 'main' }, { value: 1 });
      expect(seen).toEqual([{ value: 1 }]);
    },
  );

  it('onMcpAuditRefresh listens on its own channel and hands back nothing', () => {
    const seen: unknown[][] = [];
    api().onMcpAuditRefresh((...args: unknown[]) => seen.push(args));

    expect(ipc.on.map((entry) => entry.channel)).toEqual(['mcp:auditRefresh']);
    ipc.on[0]?.handler({ sender: 'main' }, null);
    expect(seen).toEqual([[]]);
  });
});
