import { describe, expect, it } from 'vitest';

import {
  PREVIEW_SCAN_LIMIT,
  checkDraft,
  compilePattern,
  countPatternMatches,
  entryWouldSilence,
  previewPattern,
} from '../renderer/logs/silence-preview.js';
import { REGEX_MARKER } from '../src/silence-pattern.js';
import type { LogEntry } from '../src/domain-types.js';

function warn(text: string): LogEntry {
  return {
    ts: 0,
    stream: 'stdout',
    level: 'warn',
    originalLevel: 'warn',
    line: text,
  };
}

function error(text: string): LogEntry {
  return {
    ts: 0,
    stream: 'stderr',
    level: 'error',
    originalLevel: 'error',
    line: text,
  };
}

function plain(text: string): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: text };
}

describe('renderer/logs/silence-preview.ts', () => {
  describe('checkDraft', () => {
    it('reads an empty draft as nothing to preview', () => {
      expect(checkDraft('   ', false)).toEqual({ kind: 'empty' });
    });

    it('turns a valid draft into the pattern storage will keep', () => {
      expect(checkDraft('foo.*', true)).toEqual({
        kind: 'ok',
        pattern: `${REGEX_MARKER}foo.*`,
      });
      expect(checkDraft(' ruido ', false)).toEqual({
        kind: 'ok',
        pattern: 'ruido',
      });
    });

    it('refuses a regex that does not compile, judged on what was typed', () => {
      // `*foo` is invalid on its own; the marker prefix would make it valid.
      expect(checkDraft('*foo', true)).toEqual({
        kind: 'invalid',
        message: 'Regex no válida',
      });
      expect(checkDraft('(abc', true).kind).toBe('invalid');
    });

    it('never refuses a substring, whatever characters it has', () => {
      expect(checkDraft('(abc', false)).toEqual({
        kind: 'ok',
        pattern: '(abc',
      });
    });
  });

  describe('compilePattern', () => {
    it('matches a substring case-sensitively, as storage does', () => {
      const matcher = compilePattern('Compiled');
      expect(matcher.test('Compiled ok')).toBe(true);
      expect(matcher.test('compiled ok')).toBe(false);
    });

    it('matches a regex case-insensitively, as storage does', () => {
      const matcher = compilePattern('reintento \\d+');
      expect(matcher.test('REINTENTO 12')).toBe(true);
      expect(matcher.test('reintento x')).toBe(false);
    });

    it('locates every substring occurrence', () => {
      expect(compilePattern('ab').ranges('ab-ab')).toEqual([
        [0, 2],
        [3, 5],
      ]);
    });

    it('locates regex matches and skips empty ones', () => {
      expect(compilePattern('\\d+').ranges('a12b3')).toEqual([
        [1, 3],
        [4, 5],
      ]);
      expect(compilePattern(`${REGEX_MARKER}x*`).ranges('axb')).toEqual([
        [1, 2],
      ]);
    });

    it('falls back to substring for a stored regex that does not compile', () => {
      const matcher = compilePattern('a\\');
      expect(matcher.test('trailing a\\ here')).toBe(true);
    });
  });

  describe('previewPattern', () => {
    const entries = [
      warn('\u001b[33mSuccessfully compiled a\u001b[0m'),
      error('Successfully compiled b'),
      warn('otra cosa'),
      warn('Successfully compiled c'),
      plain('Successfully compiled d'),
      warn('Successfully compiled e'),
      warn('Successfully compiled f'),
    ];

    it('counts only lines of the level the rule would apply to', () => {
      const result = previewPattern(
        entries,
        'warn',
        compilePattern('Successfully compiled'),
      );
      expect(result.count).toBe(4);
    });

    it('reads a coloured line by its text, not its escapes', () => {
      const result = previewPattern(
        [warn('\u001b[33mSuccessfully\u001b[0m compiled')],
        'warn',
        compilePattern('Successfully compiled'),
      );
      expect(result.count).toBe(1);
    });

    it('stays fast over fifty thousand held lines', () => {
      const many = Array.from({ length: 50_000 }, (_, i) =>
        i % 2 ? warn(`[${i}] DEBUG reconnect stream`) : error(`fallo ${i}`),
      );
      const started = performance.now();
      const result = previewPattern(
        many,
        'warn',
        compilePattern('\\d+\\] DEBUG'),
      );
      const elapsed = performance.now() - started;
      expect(result.count).toBe(25_000);
      expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(250);
    });

    it('scans only the newest lines past the cap, and says so', () => {
      const many = Array.from({ length: PREVIEW_SCAN_LIMIT + 10 }, () =>
        warn('ruido'),
      );
      const result = previewPattern(many, 'warn', compilePattern('ruido'));
      expect(result.count).toBe(PREVIEW_SCAN_LIMIT);
      expect(result.truncated).toBe(true);
    });
  });

  describe('countPatternMatches', () => {
    it('answers one count per pattern, over the given level only', () => {
      const entries = [
        warn('ruido 1'),
        warn('ruido 2'),
        error('ruido 3'),
        warn('reintento 9'),
      ];
      expect(
        countPatternMatches(entries, 'warn', ['ruido', 'reintento \\d']),
      ).toEqual([2, 1]);
    });
  });

  describe('entryWouldSilence', () => {
    it('is true only for a matching line of the selected level', () => {
      const matcher = compilePattern('ruido');
      expect(entryWouldSilence(warn('ruido'), 'warn', matcher)).toBe(true);
      expect(entryWouldSilence(error('ruido'), 'warn', matcher)).toBe(false);
      expect(entryWouldSilence(plain('ruido'), 'warn', matcher)).toBe(false);
    });
  });
});
