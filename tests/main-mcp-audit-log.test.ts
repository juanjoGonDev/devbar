import { describe, expect, it } from 'vitest';
import type {
  McpAuditEntry,
  McpAuditPageQuery,
  McpAuditResult,
  McpDiffLine,
} from '../src/ipc-contract/mcp-api.js';
import { createAuditLog, type AuditDraft } from '../src/main/mcp/audit-log.js';
import type { AuditKnown } from '../src/main/mcp/audit-query.js';

const DAY = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_MS = 30 * DAY;
const START = Date.UTC(2026, 10, 3, 12);

function harness(file: string | null = null) {
  let now = START;
  let ids = 0;
  let disk = file ?? '';
  const rewrites: string[] = [];
  const published: McpAuditEntry[] = [];
  let days = 30;
  let refreshes = 0;
  const log = createAuditLog({
    load: () => file,
    append: (line) => {
      disk += line;
    },
    rewrite: (content) => {
      rewrites.push(content);
      disk = content;
    },
    now: () => now,
    newId: () => `a${++ids}`,
    retentionDays: () => days,
    published: (entry) => published.push(entry),
    refreshed: () => {
      refreshes++;
    },
  });
  return {
    log,
    rewrites,
    published,
    disk: () => disk,
    refreshes: () => refreshes,
    keep: (next: number) => {
      days = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const DIFF: McpDiffLine[] = [
  { kind: 'del', field: 'comando', text: 'pnpm dev' },
  { kind: 'add', field: 'comando', text: 'pnpm dev --inspect' },
];

const KNOWN_NONE: AuditKnown = { clients: [], tools: [] };

function draft(overrides: Partial<AuditDraft> = {}): AuditDraft {
  return {
    clientId: 'c1',
    clientName: 'Claude Code',
    tool: 'get_status',
    target: 'Back',
    result: 'ok',
    summary: '3 comandos',
    ...overrides,
  };
}

describe('src/main/mcp/audit-log.ts', () => {
  it('stamps each entry and appends it as one JSON line', () => {
    const h = harness();

    const entry = h.log.record(draft());

    expect(entry).toMatchObject({ id: 'a1', at: START, tool: 'get_status' });
    expect(h.disk()).toBe(JSON.stringify(entry) + '\n');
    expect(h.published).toEqual([entry]);
  });

  it('lists newest first, capped by the limit', () => {
    const h = harness();
    h.log.record(draft({ tool: 'first' }));
    h.advance(1000);
    h.log.record(draft({ tool: 'second' }));

    expect(h.log.list({ limit: 1 }).map((e) => e.tool)).toEqual(['second']);
  });

  it('keeps only the entries of the client asked for', () => {
    const h = harness();
    h.log.record(draft());
    h.log.record(draft({ clientId: 'c2' }));

    expect(h.log.list({ limit: 10, clientId: 'c2' })).toHaveLength(1);
  });

  it('settles an entry under the same id; the last line wins on reload', () => {
    const h = harness();
    const pending = h.log.record(
      draft({ result: 'pending', undoToken: 'u1', diff: DIFF }),
    );

    h.log.update(pending.id, { result: 'ok' });
    h.log.update(pending.id, { undoToken: undefined });

    const reloaded = harness(h.disk()).log.list({ limit: 10 });
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.result).toBe<McpAuditResult>('ok');
    expect(reloaded[0]).not.toHaveProperty('undoToken');
  });

  it('answers null when settling an entry that does not exist', () => {
    expect(harness().log.update('nope', { result: 'ok' })).toBeNull();
  });

  it('finds an entry by its undo token while it has one', () => {
    const h = harness();
    const entry = h.log.record(draft({ undoToken: 'u1', diff: DIFF }));

    expect(h.log.byUndoToken('u1')?.id).toBe(entry.id);
    h.log.update(entry.id, { undoToken: undefined });
    expect(h.log.byUndoToken('u1')).toBeNull();
  });

  it("finds a client's newest change that can still be undone", () => {
    const h = harness();
    h.log.record(draft({ undoToken: 'old', diff: DIFF }));
    h.advance(1000);
    const newest = h.log.record(draft({ undoToken: 'new', diff: DIFF }));
    h.advance(1000);
    h.log.record(draft({ clientId: 'c2', undoToken: 'other', diff: DIFF }));
    h.log.record(draft());

    expect(h.log.latestUndoable('c1')?.id).toBe(newest.id);
    h.log.update(newest.id, { undoToken: undefined });
    expect(h.log.latestUndoable('c1')?.undoToken).toBe('old');
    expect(h.log.latestUndoable('nobody')).toBeNull();
  });

  it('forgets entries older than 30 days when it loads', () => {
    const old = { id: 'old', at: START - AUDIT_RETENTION_MS - 1, tool: 'x' };
    const recent = { id: 'new', at: START - DAY, tool: 'y' };
    const file = `${JSON.stringify(old)}\n${JSON.stringify(recent)}\nnot json\n`;

    const h = harness(file);

    expect(h.log.list({ limit: 10 }).map((e) => e.id)).toEqual(['new']);
    expect(h.rewrites).toEqual([JSON.stringify(recent) + '\n']);
  });

  it('prunes again once a day while it keeps running', () => {
    const h = harness();
    h.log.record(draft({ tool: 'ancient' }));
    h.advance(AUDIT_RETENTION_MS + DAY);

    h.log.record(draft({ tool: 'today' }));

    expect(h.log.list({ limit: 10 }).map((e) => e.tool)).toEqual(['today']);
  });

  it('does not rewrite a file that has nothing to prune', () => {
    const h = harness(JSON.stringify({ id: 'x', at: START }) + '\n');

    expect(h.rewrites).toEqual([]);
  });

  describe('deleting and the days it keeps', () => {
    function three() {
      const h = harness();
      const a = h.log.record(draft({ tool: 'a', undoToken: 'u1' }));
      h.advance(DAY);
      const b = h.log.record(draft({ tool: 'b', clientId: 'c2' }));
      h.advance(DAY);
      const c = h.log.record(draft({ tool: 'c', undoToken: 'u3' }));
      return { h, a, b, c };
    }
    const tools = (h: ReturnType<typeof harness>): string[] =>
      h.log.list({ limit: 10 }).map((e) => e.tool);

    it('deletes picked ids, rewrites the file and asks the windows to refresh', () => {
      const { h, a, c } = three();

      expect(h.log.remove({ kind: 'ids', ids: [a.id, c.id, 'gone'] })).toBe(2);

      expect(tools(h)).toEqual(['b']);
      expect(h.rewrites.at(-1)).toBe(
        JSON.stringify(h.log.list({ limit: 1 })[0]) + '\n',
      );
      expect(h.refreshes()).toBe(1);
    });

    it('deletes what a filter matches, but its exceptions', () => {
      const { h, a } = three();

      const deleted = h.log.remove({
        kind: 'query',
        query: { clientIds: ['c1'] },
        except: [a.id],
      });

      expect(deleted).toBe(1);
      expect(tools(h)).toEqual(['b', 'a']);
    });

    it('deletes a time window, either end open', () => {
      const { h, b } = three();

      expect(h.log.remove({ kind: 'range', to: b.at })).toBe(2);
      expect(tools(h)).toEqual(['c']);
      expect(h.log.remove({ kind: 'range', from: b.at })).toBe(1);
      expect(tools(h)).toEqual([]);
    });

    it('deletes the whole log', () => {
      const { h } = three();

      expect(h.log.remove({ kind: 'all' })).toBe(3);
      expect(h.disk()).toBe('');
    });

    it('touches nothing when the selection holds nothing', () => {
      const { h } = three();

      expect(h.log.remove({ kind: 'ids', ids: ['nope'] })).toBe(0);
      expect(h.rewrites).toEqual([]);
      expect(h.refreshes()).toBe(0);
    });

    it('counts a selection: how many, how many undoable, since when', () => {
      const { h, a } = three();

      expect(h.log.selectionInfo({ kind: 'all' })).toEqual({
        total: 3,
        undoable: 2,
        oldest: a.at,
      });
      expect(h.log.selectionInfo({ kind: 'ids', ids: [] })).toEqual({
        total: 0,
        undoable: 0,
        oldest: null,
      });
    });

    it('lists the undoable changes of a selection, newest first', () => {
      const { h } = three();

      expect(h.log.undoableIn({ kind: 'all' }).map((e) => e.tool)).toEqual([
        'c',
        'a',
      ]);
    });

    it('prunes by the days it is told to keep, at once', () => {
      const { h } = three();
      h.keep(1);
      h.advance(1);

      expect(h.log.prune()).toBe(2);

      expect(tools(h)).toEqual(['c']);
      expect(h.refreshes()).toBe(1);
      expect(
        h.log.query({ offset: 0, limit: 5 }, KNOWN_NONE).retentionDays,
      ).toBe(1);
    });

    it('keeps pruning once a day with the days it is told', () => {
      const h = harness();
      h.keep(2);
      h.log.record(draft({ tool: 'old' }));
      h.advance(3 * DAY);

      h.log.record(draft({ tool: 'new' }));

      expect(tools(h)).toEqual(['new']);
    });
  });

  describe('query', () => {
    const KNOWN: AuditKnown = {
      clients: [
        { id: 'c1', name: 'Claude Code' },
        { id: 'c2', name: 'Cursor' },
        { id: 'idle', name: 'Sin usar' },
      ],
      tools: [
        { name: 'get_status', scope: 'read' },
        { name: 'restart', scope: 'control' },
        { name: 'update_command', scope: 'config' },
      ],
    };

    /** Five calls a minute apart, oldest first. */
    function seeded() {
      const h = harness();
      const add = (overrides: Partial<AuditDraft>) => {
        h.log.record(draft(overrides));
        h.advance(60_000);
      };
      add({ tool: 'get_status', target: 'Back', summary: '3 comandos' });
      add({
        tool: 'restart',
        target: 'Front',
        clientId: 'c2',
        clientName: 'Cursor',
      });
      add({
        tool: 'update_command',
        target: 'Back › Normal',
        diff: DIFF,
        undoToken: 'u1',
      });
      add({
        tool: 'restart',
        target: 'Back',
        result: 'error',
        summary: 'código 1',
      });
      add({
        tool: 'logs',
        target: 'Viejo',
        clientId: 'gone',
        clientName: 'Antiguo',
        result: 'rejected',
      });
      return h;
    }
    const page = (
      h: ReturnType<typeof harness>,
      query: Partial<McpAuditPageQuery> = {},
    ) => h.log.query({ offset: 0, limit: 100, ...query }, KNOWN);
    const ids = (
      h: ReturnType<typeof harness>,
      query: Partial<McpAuditPageQuery> = {},
    ) => page(h, query).entries.map((e) => e.id);

    it('reads newest first and says how many there are', () => {
      const h = seeded();
      const result = page(h, { limit: 2 });
      expect(result.entries.map((e) => e.id)).toEqual(['a5', 'a4']);
      expect(result.total).toBe(5);
      expect(result.retained).toBe(5);
    });

    it('slices the page the offset and limit ask for', () => {
      const h = seeded();
      expect(ids(h, { offset: 2, limit: 2 })).toEqual(['a3', 'a2']);
      expect(ids(h, { offset: 4, limit: 2 })).toEqual(['a1']);
      expect(ids(h, { offset: 9, limit: 2 })).toEqual([]);
    });

    it('never hands out more than a hundred at once', () => {
      const h = harness();
      for (let i = 0; i < 120; i++) h.log.record(draft());
      expect(page(h, { limit: 500 }).entries).toHaveLength(100);
    });

    it.each<[string, Partial<McpAuditPageQuery>, string[]]>([
      ['clients', { clientIds: ['c2', 'gone'] }, ['a5', 'a2']],
      ['no client at all', { clientIds: [] }, []],
      ['tools', { tools: ['restart'] }, ['a4', 'a2']],
      ['results', { results: ['error', 'rejected'] }, ['a5', 'a4']],
      ['what can be undone', { undoable: true }, ['a3']],
      [
        'a time range, both ends included',
        { from: START + 60_000, to: START + 180_000 },
        ['a4', 'a3', 'a2'],
      ],
      ['the search, in the tool', { search: 'UPDATE_' }, ['a3']],
      ['the search, in the target', { search: 'front' }, ['a2']],
      ['the search, in the summary', { search: 'código' }, ['a4']],
      ['the search, in the client', { search: 'cursor' }, ['a2']],
      ['the search, in the result as read', { search: 'aplicado' }, ['a3']],
      ['the search, trimmed', { search: '  rechazado ' }, ['a5']],
      [
        'every filter at once',
        { clientIds: ['c1'], tools: ['restart'], results: ['error'] },
        ['a4'],
      ],
    ])('filters by %s', (_label, query, expected) => {
      expect(ids(seeded(), query)).toEqual(expected);
    });

    it('does not let the search run across two fields', () => {
      expect(ids(seeded(), { search: 'status back' })).toEqual([]);
    });

    it.each<[string, McpAuditPageQuery['sort'], string[]]>([
      [
        'oldest first',
        [{ key: 'time', dir: 'asc' }],
        ['a1', 'a2', 'a3', 'a4', 'a5'],
      ],
      [
        'client, then newest first',
        [{ key: 'client', dir: 'asc' }],
        ['a5', 'a4', 'a3', 'a1', 'a2'],
      ],
      [
        'action, then target',
        [{ key: 'action', dir: 'asc' }],
        ['a1', 'a5', 'a4', 'a2', 'a3'],
      ],
      [
        'errors first',
        [{ key: 'result', dir: 'desc' }],
        ['a5', 'a4', 'a3', 'a2', 'a1'],
      ],
      [
        'two keys',
        [
          { key: 'client', dir: 'desc' },
          { key: 'time', dir: 'asc' },
        ],
        ['a2', 'a1', 'a3', 'a4', 'a5'],
      ],
      ['nothing (newest first)', [], ['a5', 'a4', 'a3', 'a2', 'a1']],
    ])('sorts %s', (_label, sort, expected) => {
      expect(ids(seeded(), { sort })).toEqual(expected);
    });

    it('counts each column with every other filter but its own', () => {
      const result = page(seeded(), {
        clientIds: ['c1'],
        tools: ['restart'],
      });
      expect(result.total).toBe(1);
      expect(result.facets.clients).toEqual([
        { id: 'c1', name: 'Claude Code', count: 1 },
        { id: 'c2', name: 'Cursor', count: 1 },
        { id: 'idle', name: 'Sin usar', count: 0 },
        { id: 'gone', name: 'Antiguo', count: 0 },
      ]);
      expect(result.facets.tools).toEqual([
        { tool: 'get_status', family: 'read', count: 1 },
        { tool: 'restart', family: 'control', count: 1 },
        { tool: 'update_command', family: 'config', count: 1 },
        { tool: 'logs', family: null, count: 0 },
      ]);
      expect(result.facets.results).toEqual([
        { result: 'ok', count: 0 },
        { result: 'warning', count: 0 },
        { result: 'error', count: 1 },
        { result: 'rejected', count: 0 },
        { result: 'pending', count: 0 },
      ]);
    });

    it('leaves «se puede deshacer» out of the result counts like the results', () => {
      const result = page(seeded(), { undoable: true });
      expect(result.facets.results.find((r) => r.result === 'ok')?.count).toBe(
        3,
      );
      expect(
        result.facets.tools.find((t) => t.tool === 'update_command')?.count,
      ).toBe(1);
      expect(result.facets.tools.find((t) => t.tool === 'restart')?.count).toBe(
        0,
      );
    });

    it('keeps a picked value the log has never seen in its list', () => {
      const result = page(harness(), {
        clientIds: ['ghost'],
        tools: ['old_tool'],
      });
      expect(result.facets.clients.at(-1)).toEqual({
        id: 'ghost',
        name: 'ghost',
        count: 0,
      });
      expect(result.facets.tools.at(-1)).toEqual({
        tool: 'old_tool',
        family: null,
        count: 0,
      });
    });

    it('names a client the way the store does now', () => {
      const h = harness();
      h.log.record(draft());
      const renamed: AuditKnown = {
        clients: [{ id: 'c1', name: 'Mi Claude' }],
        tools: [],
      };
      expect(
        h.log.query({ offset: 0, limit: 10 }, renamed).facets.clients,
      ).toEqual([{ id: 'c1', name: 'Mi Claude', count: 1 }]);
    });

    it('hands out copies', () => {
      const h = seeded();
      const first = page(h).entries[0];
      if (first) first.tool = 'changed';
      expect(page(h).entries[0]?.tool).toBe('logs');
    });
  });
});
