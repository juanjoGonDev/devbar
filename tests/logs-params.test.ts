// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readLogsParams } from '../renderer/logs/params.js';

describe('renderer/logs/params.ts', () => {
  describe('readLogsParams', () => {
    it('reads a bare window as the plain single view', () => {
      expect(readLogsParams('')).toEqual({
        isDetached: false,
        filter: '',
        scope: null,
        level: null,
        processId: null,
      });
    });

    it('recognises the detached window', () => {
      expect(readLogsParams('?detached=1').isDetached).toBe(true);
    });

    it('treats any other value of detached as the shared window', () => {
      expect(readLogsParams('?detached=0').isDetached).toBe(false);
    });

    it('carries the service the window was opened on', () => {
      expect(readLogsParams('?id=g:web').processId).toBe('g:web');
    });

    it('carries a pre-filled search', () => {
      expect(readLogsParams('?filter=timeout').filter).toBe('timeout');
    });

    it('opens straight onto one group when both parts are present', () => {
      expect(readLogsParams('?scope=group&groupId=back').scope).toEqual({
        kind: 'group',
        groupId: 'back',
      });
    });

    it('refuses a group scope with no group to show', () => {
      // Half a scope is not a scope: falling through to the single view is
      // what keeps a malformed URL from opening an empty merged window.
      expect(readLogsParams('?scope=group').scope).toBeNull();
    });

    it('opens straight onto everything', () => {
      expect(readLogsParams('?scope=all').scope).toEqual({ kind: 'all' });
    });

    it('ignores a scope it does not know', () => {
      expect(readLogsParams('?scope=galaxia').scope).toBeNull();
    });

    it('pins the level a severity entry point asked for', () => {
      expect(readLogsParams('?level=warn').level).toBe('warn');
      expect(readLogsParams('?level=error').level).toBe('error');
    });

    it('ignores a level that is not a severity', () => {
      expect(readLogsParams('?level=debug').level).toBeNull();
    });
  });
});
