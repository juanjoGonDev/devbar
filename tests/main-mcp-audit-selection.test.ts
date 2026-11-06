import { describe, expect, it } from 'vitest';
import type { McpAuditEntry } from '../src/ipc-contract/mcp-api.js';
import {
  resolveSelection,
  selectionInfo,
} from '../src/main/mcp/audit-selection.js';

/**
 * What a selection of «Actividad» stands for: the four ways of picking
 * entries resolved over the log, and where the picked ones sit in a page
 * query (pages, the ones the filters hide, the rows of the page).
 */

function entry(id: string, at: number, extra: Partial<McpAuditEntry> = {}) {
  return {
    id,
    at,
    clientId: 'c1',
    clientName: 'Claude Code',
    tool: 'restart',
    target: 'Back',
    result: 'ok',
    summary: '',
    ...extra,
  } satisfies McpAuditEntry;
}

/** Ten entries, e0 the oldest; the odd ones are reads, the rest restarts. */
const LOG: McpAuditEntry[] = Array.from({ length: 10 }, (_, i) =>
  entry(`e${i}`, 1000 + i, i % 2 ? { tool: 'get_status' } : {}),
);
const ids = (entries: readonly McpAuditEntry[]): string[] =>
  entries.map((e) => e.id);

describe('src/main/mcp/audit-selection.ts', () => {
  describe('resolveSelection', () => {
    it('picks ids that exist, in the log order', () => {
      expect(
        ids(resolveSelection(LOG, { kind: 'ids', ids: ['e3', 'x', 'e1'] })),
      ).toEqual(['e1', 'e3']);
    });

    it('picks what a filter matches, minus exceptions, plus extras', () => {
      const picked = resolveSelection(LOG, {
        kind: 'query',
        query: { tools: ['get_status'] },
        except: ['e1'],
        include: ['e0'],
      });
      expect(ids(picked)).toEqual(['e0', 'e3', 'e5', 'e7', 'e9']);
    });

    it('picks a window with both ends inclusive, or open', () => {
      expect(
        ids(resolveSelection(LOG, { kind: 'range', from: 1002, to: 1004 })),
      ).toEqual(['e2', 'e3', 'e4']);
      expect(ids(resolveSelection(LOG, { kind: 'range', from: 1008 }))).toEqual(
        ['e8', 'e9'],
      );
      expect(resolveSelection(LOG, { kind: 'range' })).toHaveLength(10);
    });

    it('picks everything', () => {
      expect(resolveSelection(LOG, { kind: 'all' })).toHaveLength(10);
    });
  });

  describe('selectionInfo with a page query', () => {
    it('says on how many pages the picks sit and which are on this page', () => {
      const info = selectionInfo(
        LOG,
        { kind: 'ids', ids: ['e9', 'e8', 'e1'] },
        { offset: 0, limit: 3 },
      );
      expect(info.view).toEqual({
        outside: 0,
        pages: 2,
        onPage: ['e9', 'e8'],
        everyMatch: false,
      });
    });

    it('counts the picks the filters hide', () => {
      const info = selectionInfo(
        LOG,
        { kind: 'ids', ids: ['e0', 'e1', 'e3'] },
        { offset: 0, limit: 50, tools: ['get_status'] },
      );
      expect(info.view).toMatchObject({ outside: 1, pages: 1 });
    });

    it('knows when every match is picked', () => {
      const all = selectionInfo(
        LOG,
        { kind: 'query', query: { tools: ['restart'] } },
        { offset: 0, limit: 2, tools: ['restart'] },
      );
      expect(all.view).toEqual({
        outside: 0,
        pages: 3,
        onPage: ['e8', 'e6'],
        everyMatch: true,
      });
      const none = selectionInfo(
        LOG,
        { kind: 'all' },
        { offset: 0, limit: 2, tools: ['nothing'] },
      );
      expect(none.view?.everyMatch).toBe(false);
    });

    it('leaves the view out when no page query is given', () => {
      expect(selectionInfo(LOG, { kind: 'all' })).toEqual({
        total: 10,
        undoable: 0,
        oldest: 1000,
      });
    });
  });
});
