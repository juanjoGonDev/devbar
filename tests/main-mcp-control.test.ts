import { describe, expect, it } from 'vitest';
import type { McpSettings } from '../src/domain-types.js';
import type { McpState } from '../src/ipc-contract/mcp-api.js';
import { createAuditLog } from '../src/main/mcp/audit-log.js';
import { createClientStore } from '../src/main/mcp/client-store.js';
import { createConfirmDesk } from '../src/main/mcp/confirm-desk.js';
import {
  createMcpControl,
  type McpControlDeps,
} from '../src/main/mcp/mcp-control.js';

const COMMANDS = {
  claudeCode: 'claude mcp add devbar',
  claudeDesktopJson: '{}',
  cursorJson: '{}',
  opencodeJson: '{}',
  codexToml: '',
  generic: 'devbar',
};

function harness(
  overrides: Partial<McpControlDeps> = {},
  startError: Error | null = null,
) {
  let settings: McpSettings = {
    enabled: false,
    transport: 'stdio',
    auditRetentionDays: 30,
  };
  let listening = false;
  const pushes: McpState[] = [];
  const calls: string[] = [];
  const timers = {
    setTimer: () => null,
    clearTimer: () => undefined,
  };
  const clients = createClientStore({
    read: () => undefined,
    write: () => undefined,
    now: () => 1,
    newId: () => 'c1',
    ...timers,
  });
  let auditIds = 0;
  let auditNow = 1;
  const audit = createAuditLog({
    load: () => null,
    append: () => undefined,
    rewrite: () => undefined,
    now: () => auditNow,
    newId: () => `a${++auditIds}`,
    retentionDays: () => settings.auditRetentionDays,
    published: () => undefined,
    refreshed: () => undefined,
  });
  const desk = createConfirmDesk({
    now: () => 1,
    newId: () => 'r1',
    ...timers,
    requested: () => undefined,
    closed: () => calls.push('closed'),
  });
  const control = createMcpControl({
    settings: {
      get: () => settings,
      save: (next) => {
        settings = next;
        calls.push(`save:${next.enabled}`);
      },
    },
    clients,
    audit,
    tools: [{ name: 'get_ports', scope: 'read' }],
    desk,
    endpoint: {
      start: () => {
        calls.push('start');
        if (startError) return Promise.reject(startError);
        listening = true;
        return Promise.resolve();
      },
      stop: () => {
        calls.push('stop');
        listening = false;
        return Promise.resolve();
      },
      listening: () => listening,
    },
    connectCommand: () => COMMANDS,
    restore: () => {
      calls.push('restore');
      return Promise.resolve({ ok: true });
    },
    changed: (state) => pushes.push(state),
    ...overrides,
  });
  const later = (ms: number): void => {
    auditNow += ms;
  };
  return { control, clients, audit, desk, pushes, calls, later };
}

/** A configuration change that can be undone with `token`. */
function change(tool: string, token: string) {
  return {
    clientId: 'c1',
    clientName: 'Claude Code',
    tool,
    target: 'Back',
    result: 'ok' as const,
    summary: '',
    diff: [],
    undoToken: token,
  };
}

describe('src/main/mcp/mcp-control.ts', () => {
  it('paints the switch, the clients and the connect lines', () => {
    const h = harness();
    h.clients.identify({ name: 'claude-code' });

    expect(h.control.state()).toMatchObject({
      settings: { enabled: false, transport: 'stdio', auditRetentionDays: 30 },
      clients: [{ id: 'c1', status: 'pending' }],
      connectCommand: COMMANDS,
      listening: false,
      error: null,
    });
  });

  it('starts the endpoint when switched on and pushes the new state', async () => {
    const h = harness();

    const state = await h.control.setEnabled(true);

    expect(h.calls).toEqual(['save:true', 'start']);
    expect(state).toMatchObject({
      settings: { enabled: true },
      listening: true,
    });
    expect(h.pushes.at(-1)).toEqual(state);
  });

  it('reports why the endpoint could not start, in Spanish', async () => {
    const h = harness({}, new Error('EADDRINUSE'));

    const state = await h.control.setEnabled(true);

    expect(state.error).toBe('No se pudo abrir el servidor MCP: EADDRINUSE');
  });

  it('stops the endpoint and cancels pending confirmations when switched off', async () => {
    const h = harness();
    await h.control.setEnabled(true);
    void h.desk.ask({
      clientName: 'x',
      title: 't',
      subtitle: 's',
      risk: 'cosmetic',
      diff: [],
    }).outcome;

    await h.control.setEnabled(false);

    expect(h.calls).toEqual([
      'save:true',
      'start',
      'save:false',
      'closed',
      'stop',
    ]);
  });

  it('starts at boot only when the switch is on', async () => {
    const off = harness();
    await off.control.startIfEnabled();
    expect(off.calls).toEqual([]);

    const on = harness();
    await on.control.setEnabled(true);
    await on.control.setEnabled(false);
    on.calls.length = 0;
    await on.control.startIfEnabled();
    expect(on.calls).toEqual([]);
  });

  it('approves, updates and revokes through the client store', () => {
    const h = harness();
    h.clients.identify({ name: 'claude-code' });

    expect(h.control.approve('c1', { config: true })).toMatchObject({
      ok: true,
      state: { clients: [{ status: 'allowed', scopes: { config: true } }] },
    });
    expect(h.control.update('c1', { redactSecrets: false })).toMatchObject({
      ok: true,
      state: { clients: [{ redactSecrets: false }] },
    });
    expect(h.control.revoke('c1')).toMatchObject({
      ok: true,
      state: { clients: [{ status: 'revoked' }] },
    });
    expect(h.control.reject('nope')).toEqual({
      ok: false,
      error: 'Ese cliente MCP ya no existe',
    });
  });

  it('pushes the state when a new client shows up', () => {
    const h = harness();

    h.clients.identify({ name: 'cursor' });

    expect(h.pushes.at(-1)?.clients).toHaveLength(1);
  });

  it('undoes through the restore hook and then retires the token', async () => {
    const h = harness();
    h.audit.record({
      clientId: 'c1',
      clientName: 'Claude Code',
      tool: 'update_command',
      target: 'Back › Normal',
      result: 'ok',
      summary: 'comando',
      diff: [],
      undoToken: 'u1',
    });

    await expect(h.control.undo('u1')).resolves.toEqual({ ok: true });
    await expect(h.control.undo('u1')).resolves.toEqual({
      ok: false,
      error: 'Ese cambio ya no se puede deshacer',
    });
    expect(h.calls).toEqual(['restore']);
  });

  it('keeps the token when the restore fails', async () => {
    const h = harness({
      restore: () => Promise.resolve({ ok: false, error: 'disco lleno' }),
    });
    h.audit.record({
      clientId: 'c1',
      clientName: 'Claude Code',
      tool: 'delete_group',
      target: 'Back',
      result: 'ok',
      summary: '',
      undoToken: 'u1',
    });

    await expect(h.control.undo('u1')).resolves.toEqual({
      ok: false,
      error: 'disco lleno',
    });
    expect(h.audit.byUndoToken('u1')).not.toBeNull();
  });

  it('answers and lists confirmations through the desk', async () => {
    const h = harness();
    const asked = h.desk.ask({
      clientName: 'x',
      title: 't',
      subtitle: 's',
      risk: 'destructive',
      diff: [],
    });

    expect(h.control.listConfirms().map((r) => r.id)).toEqual([asked.id]);
    expect(h.control.answerConfirm(asked.id, 'reject')).toEqual({ ok: true });
    await expect(asked.outcome).resolves.toBe('rejected');
  });

  it('flushes usage and closes on shutdown', async () => {
    const h = harness();
    await h.control.setEnabled(true);

    await h.control.shutdown();

    expect(h.calls.at(-1)).toBe('stop');
  });

  it('pages the audit through the log, with the clients and tools it knows', () => {
    const h = harness();
    h.audit.record({
      clientId: 'c1',
      clientName: 'Claude Code',
      tool: 'get_ports',
      target: 'Front',
      result: 'ok',
      summary: ':4400',
    });

    const page = h.control.queryAudit({ offset: 0, limit: 5 });

    expect(page.entries.map((e) => e.tool)).toEqual(['get_ports']);
    expect(page.facets.tools).toEqual([
      { tool: 'get_ports', family: 'read', count: 1 },
    ]);
  });

  describe('bulk changes to the log', () => {
    it('undoes every undoable change of a selection, newest first', async () => {
      const restored: string[] = [];
      const h = harness({
        restore: (entry) => {
          restored.push(entry.tool);
          return Promise.resolve({ ok: true });
        },
      });
      h.audit.record(change('first', 'u1'));
      h.later(1000);
      h.audit.record({ ...change('read', 'x'), undoToken: undefined });
      h.later(1000);
      h.audit.record(change('second', 'u2'));

      await expect(h.control.undoMany({ kind: 'all' })).resolves.toEqual({
        undone: 2,
        failed: 0,
      });
      expect(restored).toEqual(['second', 'first']);
      expect(h.audit.byUndoToken('u1')).toBeNull();
      expect(h.audit.byUndoToken('u2')).toBeNull();
    });

    it('keeps going past a failure and reports why, once per reason', async () => {
      const h = harness({
        restore: (entry) =>
          entry.tool === 'ok'
            ? Promise.resolve({ ok: true })
            : entry.tool === 'boom'
              ? Promise.reject(new Error('sin disco'))
              : Promise.resolve({ ok: false, error: 'Ya no existe' }),
      });
      h.audit.record(change('gone', 'u1'));
      h.later(1);
      h.audit.record(change('ok', 'u2'));
      h.later(1);
      h.audit.record(change('gone', 'u3'));
      h.later(1);
      h.audit.record(change('boom', 'u4'));

      await expect(h.control.undoMany({ kind: 'all' })).resolves.toEqual({
        undone: 1,
        failed: 3,
        errors: ['sin disco', 'Ya no existe'],
      });
      expect(h.audit.byUndoToken('u1')).not.toBeNull();
      expect(h.audit.byUndoToken('u2')).toBeNull();
    });

    it('only undoes what the selection holds', async () => {
      const h = harness();
      const kept = h.audit.record(change('kept', 'u1'));
      const picked = h.audit.record(change('picked', 'u2'));

      await expect(
        h.control.undoMany({ kind: 'ids', ids: [picked.id] }),
      ).resolves.toEqual({ undone: 1, failed: 0 });
      expect(h.audit.byUndoToken('u1')?.id).toBe(kept.id);
    });

    it('counts and deletes a selection through the log', () => {
      const h = harness();
      h.audit.record(change('a', 'u1'));
      h.audit.record({ ...change('b', 'x'), undoToken: undefined });

      expect(h.control.auditSelectionInfo({ kind: 'all' })).toEqual({
        total: 2,
        undoable: 1,
        oldest: 1,
      });
      expect(h.control.deleteAudit({ kind: 'all' })).toEqual({ deleted: 2 });
      expect(h.control.queryAudit({ offset: 0, limit: 5 }).retained).toBe(0);
    });

    it('saves the days to keep, prunes what is older and pushes the state', () => {
      const h = harness();
      h.audit.record(change('old', 'u1'));
      h.later(3 * 24 * 60 * 60 * 1000);
      h.audit.record(change('new', 'u2'));

      expect(h.control.setAuditRetention(2)).toEqual({ days: 2, deleted: 1 });
      expect(h.pushes.at(-1)?.settings.auditRetentionDays).toBe(2);
      expect(h.control.queryAudit({ offset: 0, limit: 5 })).toMatchObject({
        retained: 1,
        retentionDays: 2,
      });
    });
  });
});
