import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearColumn,
  clickSort,
  columnOf,
  describeFilter,
  dropSort,
  groupsByDay,
  initialState,
  isDefaultSort,
  isFiltered,
  localInput,
  narrows,
  pickSort,
  timeWindow,
  toQuery,
} from '../renderer/config/mcp-activity-model.js';

/**
 * The rules behind «Actividad» (renderer/config/mcp-activity-model.ts): how a
 * click changes the sort keys, what counts as a filter, and the query main
 * is asked for.
 */

const NOW = new Date(2026, 10, 6, 9, 0).getTime();

describe('renderer/config/mcp-activity-model.ts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sorting', () => {
    it('cycles a plain click between its two directions', () => {
      const once = clickSort(initialState().sort, 'action', false);
      expect(once).toEqual([{ key: 'action', dir: 'asc' }]);
      expect(clickSort(once, 'action', false)).toEqual([
        { key: 'action', dir: 'desc' },
      ]);
    });

    it('turns the time round on its first click, newest first being the start', () => {
      expect(clickSort(initialState().sort, 'time', false)).toEqual([
        { key: 'time', dir: 'asc' },
      ]);
    });

    it('adds, turns and removes a key with Shift', () => {
      const added = clickSort(initialState().sort, 'client', true);
      expect(added).toEqual([
        { key: 'time', dir: 'desc' },
        { key: 'client', dir: 'asc' },
      ]);
      const turned = clickSort(added, 'client', true);
      expect(turned[1]).toEqual({ key: 'client', dir: 'desc' });
      expect(clickSort(turned, 'client', true)).toEqual([
        { key: 'time', dir: 'desc' },
      ]);
    });

    it('updates a key in place when it is picked again', () => {
      const sort = pickSort(
        [
          { key: 'client', dir: 'asc' },
          { key: 'result', dir: 'desc' },
        ],
        'client',
        'desc',
        true,
      );
      expect(sort[0]).toEqual({ key: 'client', dir: 'desc' });
    });

    it('falls back to newest first when the last key goes', () => {
      expect(dropSort([{ key: 'client', dir: 'asc' }], 'client')).toEqual([
        { key: 'time', dir: 'desc' },
      ]);
      expect(isDefaultSort(dropSort([], 'time'))).toBe(true);
    });

    it('groups by day only while the time leads', () => {
      expect(groupsByDay([{ key: 'time', dir: 'asc' }])).toBe(true);
      expect(
        groupsByDay([
          { key: 'result', dir: 'asc' },
          { key: 'time', dir: 'asc' },
        ]),
      ).toBe(false);
    });

    it('knows each column by its key', () => {
      expect(columnOf('result').desc).toBe('Errores primero');
    });
  });

  describe('filters', () => {
    it('counts the switch as part of «Resultado»', () => {
      const state = initialState();
      expect(narrows(state)).toBe(false);
      state.undoable = true;
      expect(isFiltered(state, 'result')).toBe(true);
      clearColumn(state, 'result');
      expect(isFiltered(state, 'result')).toBe(false);
    });

    it('counts a search of only spaces as none', () => {
      const state = initialState();
      state.search = '   ';
      expect(narrows(state)).toBe(false);
    });

    it('clears each column', () => {
      const state = initialState();
      state.time = { when: '1h', from: '', to: '' };
      state.clients = new Set(['c']);
      state.tools = new Set(['t']);
      for (const column of ['time', 'client', 'action'] as const)
        clearColumn(state, column);
      expect(narrows(state)).toBe(false);
    });

    it('describes a client it no longer knows by its id', () => {
      const state = initialState();
      state.clients = new Set(['ghost']);
      expect(describeFilter(state, 'client', null)).toBe('ghost');
      state.tools = new Set();
      expect(describeFilter(state, 'action', null)).toBe('ninguna');
      state.results = new Set();
      expect(describeFilter(state, 'result', null)).toBe('ninguno');
    });

    it('reads an empty or broken range end as open', () => {
      expect(timeWindow({ when: 'custom', from: 'nope', to: '' }, NOW)).toEqual(
        {},
      );
      const state = initialState();
      state.time = { when: 'custom', from: '', to: '' };
      expect(describeFilter(state, 'time', null)).toBe('… → ahora');
    });

    it('writes a datetime-local value in local time', () => {
      expect(localInput(NOW)).toBe('2026-11-06T09:00');
    });
  });

  describe('the query', () => {
    it('carries only what narrows, plus the page', () => {
      vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
      const state = initialState();
      state.page = 3;
      state.size = 25;
      state.search = '  restart ';
      state.clients = new Set(['c1']);
      state.tools = new Set(['restart']);
      state.results = new Set(['error']);
      state.undoable = true;
      state.time = { when: '1h', from: '', to: '' };
      expect(toQuery(state, NOW)).toEqual({
        offset: 50,
        limit: 25,
        sort: [{ key: 'time', dir: 'desc' }],
        from: NOW - 60 * 60 * 1000,
        search: 'restart',
        clientIds: ['c1'],
        tools: ['restart'],
        results: ['error'],
        undoable: true,
      });
    });
  });
});
