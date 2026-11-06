import { describe, expect, it } from 'vitest';

import { badgeOf, looksDebug } from '../renderer/logs/line-level.js';
import type { LogEntry } from '../src/domain-types.js';

function line(text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: text, ...extra };
}

describe('renderer/logs/line-level.ts', () => {
  describe('looksDebug', () => {
    it.each([
      'DEBUG cache warmed',
      '2024-01-01 debug: polling',
      '[debug] reconnecting',
      'ts=1 level=debug msg=hello',
      '{"level":"debug","msg":"x"}',
      '[HarnessFF] DBG No metrics to send',
    ])('recognises a debug token in %j', (text) => {
      expect(looksDebug(text)).toBe(true);
    });

    it.each([
      'Server started',
      'debugger attached on 9229',
      'undebuggable state',
      'level=info msg=debug-free',
    ])('leaves %j alone', (text) => {
      expect(looksDebug(text)).toBe(false);
    });

    it('reads the text behind the ANSI colour, not the escapes', () => {
      expect(looksDebug('\u001b[90mDEBUG\u001b[0m tick')).toBe(true);
    });
  });

  describe('badgeOf', () => {
    it('labels a detected error ERR and a detected warning WRN', () => {
      expect(badgeOf(line('boom', { level: 'error' }))).toBe('err');
      expect(badgeOf(line('ojo', { level: 'warn' }))).toBe('wrn');
    });

    it('keeps the level a silenced line came in with', () => {
      expect(badgeOf(line('ojo', { level: null, originalLevel: 'warn' }))).toBe(
        'wrn',
      );
    });

    it('labels a debug-looking line DBG', () => {
      expect(badgeOf(line('[debug] tick'))).toBe('dbg');
    });

    it('lets the detectors win over a debug token', () => {
      expect(badgeOf(line('DEBUG failed', { level: 'error' }))).toBe('err');
    });

    it('labels everything else INF', () => {
      expect(badgeOf(line('hola'))).toBe('inf');
    });
  });
});
