import { describe, expect, it } from 'vitest';

import {
  SHOWN_STOPPED,
  arrangeGroup,
  isActive,
  runningOfTotal,
} from '../renderer/logs/sidebar-order.js';
import type { LogListItem } from '../src/ipc-contract.js';

function item(id: string, status: LogListItem['status']): LogListItem {
  return {
    id,
    type: 'command',
    name: id,
    icon: null,
    iconColor: null,
    lineCount: 0,
    status,
    warnCount: 0,
    errorCount: 0,
    startedAt: null,
    lastFinishedAt: null,
    logLimit: 5000,
  };
}

describe('renderer/logs/sidebar-order.ts', () => {
  describe('isActive', () => {
    it('counts running and the states either side of it', () => {
      expect(isActive(item('a', 'running'))).toBe(true);
      expect(isActive(item('a', 'starting'))).toBe(true);
      expect(isActive(item('a', 'stopping'))).toBe(true);
      expect(isActive(item('a', 'stopped'))).toBe(false);
      expect(isActive(item('a', 'error'))).toBe(false);
      expect(isActive(item('a', 'done'))).toBe(false);
    });
  });

  describe('arrangeGroup', () => {
    it('lists what is running first, keeping the config order within each half', () => {
      const items = [
        item('a', 'stopped'),
        item('b', 'running'),
        item('c', 'stopped'),
        item('d', 'starting'),
      ];
      expect(arrangeGroup(items, false)).toEqual({
        order: ['b', 'd', 'a', 'c'],
        folded: [],
      });
    });

    it(`folds nothing while there are ${SHOWN_STOPPED} stopped or fewer`, () => {
      const items = ['a', 'b', 'c'].map((id) => item(id, 'stopped'));
      expect(arrangeGroup(items, false).folded).toEqual([]);
    });

    it('folds the stopped ones past the first few', () => {
      const items = [
        item('on', 'running'),
        ...['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 'stopped')),
      ];
      expect(arrangeGroup(items, false)).toEqual({
        order: ['on', 'a', 'b', 'c', 'd', 'e'],
        folded: ['d', 'e'],
      });
    });

    it('folds nothing once the reader opened the fold', () => {
      const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 'stopped'));
      expect(arrangeGroup(items, true).folded).toEqual([]);
    });
  });

  describe('runningOfTotal', () => {
    it('says how many of the group are doing something', () => {
      expect(
        runningOfTotal([
          item('a', 'running'),
          item('b', 'stopped'),
          item('c', 'stopped'),
        ]),
      ).toBe('1/3');
    });
  });
});
