import { beforeEach, describe, expect, it } from 'vitest';

import {
  currentItem,
  installNav,
  itemById,
  nav,
  view,
} from '../renderer/logs/view.js';
import type { LogListItem } from '../src/ipc-contract.js';

function item(id: string): LogListItem {
  return {
    id,
    type: 'command',
    name: id,
    icon: null,
    lineCount: 0,
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    startedAt: null,
    lastFinishedAt: null,
    logLimit: 100,
  };
}

describe('renderer/logs/view.ts', () => {
  beforeEach(() => {
    view.sideData = [
      {
        groupId: 'g1',
        groupName: 'Back',
        groupIcon: '📁',
        items: [item('g1:web'), item('g1:api')],
      },
    ];
    view.processId = null;
  });

  describe('itemById', () => {
    it('finds a service wherever in the tree it lives', () => {
      expect(itemById('g1:api')?.name).toBe('g1:api');
    });

    it('answers null for a service main no longer lists', () => {
      // A service can disappear between a click and the repaint that follows.
      expect(itemById('g1:se-fue')).toBeNull();
    });
  });

  describe('currentItem', () => {
    it('resolves whatever the window is showing', () => {
      view.processId = 'g1:web';
      expect(currentItem()?.id).toBe('g1:web');
    });

    it('answers null while a merged scope is on screen', () => {
      expect(currentItem()).toBeNull();
    });
  });

  describe('installNav', () => {
    it('hands the scope switcher to the panes that sit below it', async () => {
      const opened: string[] = [];
      installNav({
        openScope: (scope) => {
          opened.push(scope.kind);
          return Promise.resolve();
        },
        jumpToLine: () => Promise.resolve(),
      });
      await nav.openScope({ kind: 'all' });
      expect(opened).toEqual(['all']);
    });
  });
});
