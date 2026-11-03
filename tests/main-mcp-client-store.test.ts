import { describe, expect, it } from 'vitest';
import type {
  McpClient,
  McpClientKind,
  McpConfirmPolicies,
  McpClientStatus,
} from '../src/ipc-contract/mcp-api.js';
import {
  clientKind,
  createClientStore,
  displayName,
  localDay,
  normalizeClientRecord,
  USAGE_FLUSH_MS,
  type McpClientInfo,
  type McpClientRecord,
} from '../src/main/mcp/client-store.js';

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 10, 3, 12, 0, 0).getTime();

function harness(seed: unknown = undefined) {
  let now = NOON;
  let ids = 0;
  const writes: McpClientRecord[][] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const changes: McpClient[] = [];
  const store = createClientStore({
    read: () => seed,
    write: (records) => writes.push([...records]),
    now: () => now,
    newId: () => `c${++ids}`,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  store.onChange((client) => changes.push(client));
  return {
    store,
    writes,
    timers,
    changes,
    advance: (ms: number) => {
      now += ms;
    },
    fireTimers: () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    },
  };
}

const CLAUDE_CODE: McpClientInfo = { name: 'claude-code', version: '2.1.0' };

describe('src/main/mcp/client-store.ts', () => {
  describe('clientKind', () => {
    it.each<[string, McpClientKind]>([
      ['claude-code', 'claude-code'],
      ['Claude Code', 'claude-code'],
      ['claude-ai', 'claude-desktop'],
      ['cursor-vscode', 'cursor'],
      ['my-agent', 'other'],
    ])('reads %s as %s', (name, kind) => {
      expect(clientKind(name)).toBe(kind);
    });
  });

  describe('displayName', () => {
    it('names the known assistants the way their makers do', () => {
      expect(displayName({ name: 'claude-ai' })).toBe('Claude Desktop');
    });

    it('prefers the title an unknown client announces', () => {
      expect(displayName({ name: 'agent-x', title: ' Agent X ' })).toBe(
        'Agent X',
      );
    });

    it('falls back to a generic name for a blank one', () => {
      expect(displayName({ name: '   ' })).toBe('Cliente MCP');
    });
  });

  describe('identify', () => {
    it('stores a new assistant as pending, with the approved defaults ready', () => {
      const h = harness();
      const confirm: McpConfirmPolicies = {
        control: 'never',
        workflows: 'first',
        config: 'always',
      };

      const client = h.store.identify(CLAUDE_CODE);

      expect(client).toMatchObject({
        id: 'c1',
        name: 'Claude Code',
        kind: 'claude-code',
        status: 'pending',
        createdAt: NOON,
        callsToday: 0,
        scopes: { read: true, control: true, workflows: true, config: false },
        confirm,
        groups: 'all',
        redactSecrets: true,
      });
      expect(h.writes).toHaveLength(1);
      expect(h.changes.map((c) => c.id)).toEqual(['c1']);
    });

    it('matches the same assistant again, whatever the case of its name', () => {
      const h = harness();
      const first = h.store.identify(CLAUDE_CODE);

      const again = h.store.identify({ name: 'CLAUDE-CODE' });

      expect(again.id).toBe(first.id);
      expect(h.store.list()).toHaveLength(1);
    });

    it('never hands out its matching key', () => {
      const h = harness();

      expect(h.store.identify(CLAUDE_CODE)).not.toHaveProperty('key');
    });
  });

  describe('status changes', () => {
    it('approves with the requested scopes on top of the defaults', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);

      const result = h.store.approve(id, { config: true, control: false });

      expect(result).toMatchObject({
        ok: true,
        client: {
          status: 'allowed',
          scopes: { read: true, control: false, workflows: true, config: true },
        },
      });
    });

    it('rejects only a pending client', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);
      expect(h.store.reject(id)).toMatchObject({
        ok: true,
        client: { status: 'revoked' },
      });

      expect(h.store.reject(id)).toEqual({
        ok: false,
        error: 'Solo se puede rechazar un cliente pendiente',
      });
    });

    it.each<[string, McpClientStatus]>([
      ['revoke', 'revoked'],
      ['approve', 'allowed'],
    ])('lets %s act on any client', (action, status) => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);

      const result =
        action === 'revoke' ? h.store.revoke(id) : h.store.approve(id);

      expect(result).toMatchObject({ ok: true, client: { status } });
    });

    it('answers an unknown id in Spanish', () => {
      const h = harness();

      expect(h.store.revoke('nope')).toEqual({
        ok: false,
        error: 'Ese cliente MCP ya no existe',
      });
    });

    it('writes a status change at once and tells the listeners', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);
      h.writes.length = 0;

      h.store.approve(id);

      expect(h.writes).toHaveLength(1);
      expect(h.changes.at(-1)?.status).toBe('allowed');
    });
  });

  describe('update', () => {
    it('changes the name, scopes, policies, groups and redaction', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);

      const result = h.store.update(id, {
        name: '  Mi Claude  ',
        scopes: { config: true },
        confirm: { control: 'always' },
        groups: ['g1', 'g1', 'g2'],
        redactSecrets: false,
      });

      expect(result).toMatchObject({
        ok: true,
        client: {
          name: 'Mi Claude',
          scopes: { read: true, control: true, workflows: true, config: true },
          confirm: { control: 'always', workflows: 'first', config: 'always' },
          groups: ['g1', 'g2'],
          redactSecrets: false,
        },
      });
    });

    it('refuses a blank name and keeps the old one', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);

      expect(h.store.update(id, { name: '  ' })).toEqual({
        ok: false,
        error: 'El nombre no puede estar vacío',
      });
      expect(h.store.get(id)?.name).toBe('Claude Code');
    });

    it('opens every group again with "all"', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);
      h.store.update(id, { groups: ['g1'] });

      h.store.update(id, { groups: 'all' });

      expect(h.store.get(id)?.groups).toBe('all');
    });
  });

  describe('recordCall', () => {
    it('counts calls and the last use, writing them once after a pause', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);
      h.writes.length = 0;
      h.advance(1000);

      h.store.recordCall(id);
      h.store.recordCall(id);

      expect(h.store.get(id)).toMatchObject({
        callsToday: 2,
        lastUsedAt: NOON + 1000,
      });
      expect(h.writes).toHaveLength(0);
      expect(h.timers.map((t) => t.ms)).toEqual([USAGE_FLUSH_MS]);
      h.fireTimers();
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]?.[0]?.callsToday).toBe(2);
    });

    it('starts counting again on a new day', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);
      h.store.recordCall(id);
      h.advance(DAY);

      expect(h.store.get(id)?.callsToday).toBe(0);
      h.store.recordCall(id);
      expect(h.store.get(id)?.callsToday).toBe(1);
    });

    it('flushes pending usage on demand', () => {
      const h = harness();
      const { id } = h.store.identify(CLAUDE_CODE);
      h.writes.length = 0;
      h.store.recordCall(id);

      h.store.flush();

      expect(h.writes).toHaveLength(1);
      expect(h.timers[0]?.cleared).toBe(true);
    });

    it('ignores a call from a client that is gone', () => {
      const h = harness();

      h.store.recordCall('nope');

      expect(h.timers).toHaveLength(0);
    });
  });

  describe('reading what was stored', () => {
    it('drops what cannot be a client and repairs the rest', () => {
      const h = harness([
        null,
        { id: '', key: 'x' },
        {
          id: 'c9',
          key: 'cursor-vscode',
          status: 'weird',
          scopes: { read: 'yes', config: true },
          confirm: { control: 'sometimes', workflows: 'always' },
          groups: ['g1', 3],
          redactSecrets: 'no',
          createdAt: 'then',
        },
      ]);

      expect(h.store.list()).toEqual([
        {
          id: 'c9',
          name: 'Cursor',
          kind: 'cursor',
          status: 'pending',
          createdAt: 0,
          lastUsedAt: null,
          callsToday: 0,
          scopes: { read: true, control: true, workflows: true, config: true },
          confirm: { control: 'never', workflows: 'always', config: 'always' },
          groups: ['g1'],
          redactSecrets: true,
        },
      ]);
    });

    it('treats a store that is not a list as empty', () => {
      expect(harness({ clients: [] }).store.list()).toEqual([]);
    });

    it('rejects a record without a matching key', () => {
      expect(normalizeClientRecord({ id: 'c1' })).toBeNull();
    });
  });

  describe('localDay', () => {
    it('formats the local calendar day', () => {
      expect(localDay(NOON)).toBe('2026-11-03');
    });
  });
});
