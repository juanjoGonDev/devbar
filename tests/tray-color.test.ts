import { describe, expect, it } from 'vitest';
import { deriveColor } from '../src/process/tray-color.js';
import type { ProcessState } from '../src/domain-types.js';

/**
 * The tray colour one process contributes. Two rules carry the weight:
 * a process that is NOT running reports its last outcome (an error survives
 * the stop), and a running one reports its worst level that nobody muted —
 * where "nobody" spans the global settings, the group and the command.
 */
type ColorState = Pick<
  ProcessState,
  'status' | 'lastError' | 'errorCount' | 'warnCount'
>;

function state(patch: Partial<ColorState> = {}): ColorState {
  return {
    status: 'running',
    lastError: null,
    errorCount: 0,
    warnCount: 0,
    ...patch,
  };
}

describe('src/process/tray-color.ts', () => {
  describe('a process that is not running', () => {
    it('is stopped when its last run left no error behind', () => {
      expect(deriveColor(state({ status: 'stopped' }), null, null, null)).toBe(
        'stopped',
      );
    });

    it('still reports the error its last run left behind', () => {
      expect(
        deriveColor(
          state({ status: 'stopped', lastError: 'exited with code 1' }),
          null,
          null,
          null,
        ),
      ).toBe('error');
    });

    it('ignores the live counters once it is no longer running', () => {
      // A finished action keeps its warn/error tallies; they describe a run
      // that is over, so only lastError decides the colour.
      expect(
        deriveColor(
          state({ status: 'done', errorCount: 9, warnCount: 9 }),
          null,
          null,
          null,
        ),
      ).toBe('stopped');
    });
  });

  describe('a running process', () => {
    it('is plain running with nothing counted', () => {
      expect(deriveColor(state(), null, null, null)).toBe('running');
    });

    it('reports a warning when only warnings were counted', () => {
      expect(deriveColor(state({ warnCount: 1 }), null, null, null)).toBe(
        'warn',
      );
    });

    it('reports an error when errors were counted', () => {
      expect(deriveColor(state({ errorCount: 1 }), null, null, null)).toBe(
        'error',
      );
    });

    it('lets an error outrank a warning counted in the same run', () => {
      expect(
        deriveColor(state({ errorCount: 1, warnCount: 5 }), null, null, null),
      ).toBe('error');
    });

    it('ignores a lastError left over from an earlier run', () => {
      expect(
        deriveColor(
          state({ lastError: 'exited with code 1' }),
          null,
          null,
          null,
        ),
      ).toBe('running');
    });
  });

  describe('silencing, from any of the three levels', () => {
    it('drops an error the command silences', () => {
      expect(
        deriveColor(
          state({ errorCount: 3 }),
          { silenceErrors: true },
          null,
          null,
        ),
      ).toBe('running');
    });

    it('drops an error the group silences', () => {
      expect(
        deriveColor(
          state({ errorCount: 3 }),
          null,
          { silenceErrors: true },
          null,
        ),
      ).toBe('running');
    });

    it('drops an error the global settings silence', () => {
      expect(
        deriveColor(state({ errorCount: 3 }), null, null, {
          silenceErrors: true,
        }),
      ).toBe('running');
    });

    it('falls back to the warning when only the error is silenced', () => {
      expect(
        deriveColor(state({ errorCount: 3, warnCount: 2 }), null, null, {
          silenceErrors: true,
        }),
      ).toBe('warn');
    });

    it('drops a warning the group silences while keeping the error', () => {
      expect(
        deriveColor(
          state({ errorCount: 1, warnCount: 2 }),
          null,
          { silenceWarnings: true },
          null,
        ),
      ).toBe('error');
    });

    it('is plain running once both levels are silenced', () => {
      expect(
        deriveColor(state({ errorCount: 1, warnCount: 2 }), null, null, {
          silenceErrors: true,
          silenceWarnings: true,
        }),
      ).toBe('running');
    });

    it('does not let silencing one level silence the other', () => {
      // silenceWarnings must not reach the error branch: a muted-warning
      // command whose service is erroring still has to go red.
      expect(
        deriveColor(
          state({ errorCount: 1 }),
          { silenceWarnings: true },
          null,
          null,
        ),
      ).toBe('error');
    });
  });
});
