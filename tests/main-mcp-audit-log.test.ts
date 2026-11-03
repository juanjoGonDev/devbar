import { describe, expect, it } from 'vitest';
import type {
  McpAuditEntry,
  McpAuditResult,
  McpDiffLine,
} from '../src/ipc-contract/mcp-api.js';
import {
  AUDIT_RETENTION_MS,
  createAuditLog,
  type AuditDraft,
} from '../src/main/mcp/audit-log.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 3, 12);

function harness(file: string | null = null) {
  let now = START;
  let ids = 0;
  let disk = file ?? '';
  const rewrites: string[] = [];
  const published: McpAuditEntry[] = [];
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
    published: (entry) => published.push(entry),
  });
  return {
    log,
    rewrites,
    published,
    disk: () => disk,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const DIFF: McpDiffLine[] = [
  { kind: 'del', field: 'comando', text: 'pnpm dev' },
  { kind: 'add', field: 'comando', text: 'pnpm dev --inspect' },
];

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

  it.each<['all' | 'changes' | 'rejected', string[]]>([
    ['all', ['delete_group', 'update_command', 'get_status']],
    ['changes', ['update_command']],
    ['rejected', ['delete_group']],
  ])('filters %s', (filter, tools) => {
    const h = harness();
    h.log.record(draft());
    h.advance(1);
    h.log.record(draft({ tool: 'update_command', diff: DIFF }));
    h.advance(1);
    h.log.record(draft({ tool: 'delete_group', result: 'rejected' }));

    expect(h.log.list({ limit: 10, filter }).map((e) => e.tool)).toEqual(tools);
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
});
