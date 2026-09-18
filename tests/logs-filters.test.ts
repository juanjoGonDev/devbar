import { describe, expect, it } from 'vitest';

import {
  buildFilter,
  clientMatchesPattern,
  levelOf,
  levelPillClass,
  levelPillLabel,
  matchesFilter,
  matchesLevel,
} from '../renderer/logs/filters.js';
import type { LogEntry } from '../src/domain-types.js';
import type { SilenceLevel } from '../src/ipc-contract.js';

const NO_LEVEL: ReadonlySet<SilenceLevel> = new Set();

function line(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: 0,
    stream: 'stdout',
    level: null,
    line: 'texto',
    ...partial,
  };
}

describe('renderer/logs/filters.ts', () => {
  describe('buildFilter', () => {
    it('treats an empty box as no filter at all', () => {
      expect(buildFilter('   ')).toBeNull();
    });

    it('compiles what was typed as a case-insensitive regex', () => {
      const re = buildFilter('ERR.R');
      expect(re?.test('error')).toBe(true);
    });

    it('falls back to the literal text when the regex will not compile', () => {
      // Someone halfway through typing `(foo)` is not an error to report.
      const re = buildFilter('(foo');
      expect(re?.test('a (foo bar')).toBe(true);
    });

    it('escapes every metacharacter in that fallback', () => {
      const re = buildFilter('[a+b');
      expect(re?.test('x[a+b y')).toBe(true);
    });
  });

  describe('levelOf', () => {
    it('reports the level a silenced line would have had', () => {
      expect(levelOf(line({ level: null, originalLevel: 'warn' }))).toBe(
        'warn',
      );
    });

    it('falls back to the current level when nothing was silenced', () => {
      expect(levelOf(line({ level: 'error' }))).toBe('error');
    });

    it('reports an empty level for an ordinary line', () => {
      expect(levelOf(line())).toBe('');
    });
  });

  describe('matchesLevel', () => {
    it('lets everything through while nothing is pinned', () => {
      expect(matchesLevel(NO_LEVEL, '')).toBe(true);
    });

    it('keeps only the pinned levels once one is set', () => {
      const pinned = new Set<SilenceLevel>(['warn']);
      expect(matchesLevel(pinned, 'warn')).toBe(true);
      expect(matchesLevel(pinned, 'error')).toBe(false);
    });
  });

  describe('matchesFilter', () => {
    it('requires the level pin and the text box to agree', () => {
      const warn = new Set<SilenceLevel>(['warn']);
      const entry = line({ level: 'warn', line: 'disco lleno' });
      expect(matchesFilter(entry, /lleno/iu, warn)).toBe(true);
      expect(matchesFilter(entry, /vacío/iu, warn)).toBe(false);
      expect(matchesFilter(entry, null, new Set(['error']))).toBe(false);
    });

    it('searches the text a reader sees, not its escape codes', () => {
      const entry = line({ line: '[31mfallo[0m' });
      expect(matchesFilter(entry, /^fallo$/iu, NO_LEVEL)).toBe(true);
    });
  });

  describe('clientMatchesPattern', () => {
    it('never matches on an empty pattern', () => {
      expect(clientMatchesPattern('', 'lo que sea')).toBe(false);
    });

    it('matches a plain pattern as a substring', () => {
      expect(clientMatchesPattern('war', 'a warning')).toBe(true);
      expect(clientMatchesPattern('zzz', 'a warning')).toBe(false);
    });

    it('treats a pattern with a backslash as a regex', () => {
      expect(clientMatchesPattern('reintento \\d+', 'reintento 12')).toBe(true);
    });

    it('falls back to a substring when that regex will not compile', () => {
      expect(clientMatchesPattern('a\\', 'trailing a\\ here')).toBe(true);
    });
  });

  describe('levelPillLabel', () => {
    it('names the single level the view is pinned to', () => {
      expect(levelPillLabel(['warn'])).toBe('sólo ⚠ warnings');
      expect(levelPillLabel(['error'])).toBe('sólo ⛔ errores');
    });

    it('joins both levels when the pin covers the two', () => {
      expect(levelPillLabel(['warn', 'error'])).toBe(
        'sólo ⚠ warnings + ⛔ errores',
      );
    });
  });

  describe('levelPillClass', () => {
    it('reads as a warning pill when only warnings are pinned', () => {
      expect(levelPillClass(['warn'])).toBe('level-pill warn');
    });

    it('lets errors win whenever they are part of the pin', () => {
      expect(levelPillClass(['warn', 'error'])).toBe('level-pill err');
    });
  });
});
