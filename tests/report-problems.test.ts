import { describe, expect, it } from 'vitest';
import type { ProblemEntry } from '../src/error-journal.js';
import {
  MAX_URL_CHARS_WINDOWS,
  prepareIssueReport,
} from '../src/report-issue.js';
import { countProblems } from '../src/report-problems.js';

const ctx = {
  version: '0.10.0',
  platform: 'darwin',
  arch: 'arm64',
  electron: '43.2.0',
  node: '22.22.3',
  osRelease: '25.6.0',
};

function entry(overrides: Partial<ProblemEntry> = {}): ProblemEntry {
  return {
    ts: '2026-09-30T10:00:00.000Z',
    level: 'error',
    source: 'main',
    message: 'download failed',
    count: 1,
    session: 'NOW',
    ...overrides,
  };
}

function urlBody(report: { url: string }): string {
  const match = report.url.match(/[?&]body=([^&]*)/);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

const HEADING = '### Errores y avisos recientes';

describe('src/report-problems.ts', () => {
  describe('recent errors and warnings in the bug report', () => {
    it('says so when nothing was recorded', () => {
      const report = prepareIssueReport(ctx, 'a log line', {
        problems: [],
        session: 'NOW',
      });
      for (const body of [report.clipboardText, urlBody(report)]) {
        expect(body).toContain(`${HEADING}\n\nNinguno registrado`);
      }
    });

    it('lists entries newest first, marked by session, before the log tail', () => {
      const report = prepareIssueReport(ctx, 'LOG-TAIL-LINE', {
        problems: [
          entry({
            ts: '2026-09-29T08:00:00.000Z',
            message: 'install failed',
            session: 'BEFORE',
          }),
          entry({
            level: 'warn',
            source: 'renderer:config',
            message: 'slow',
            count: 3,
          }),
        ],
        session: 'NOW',
      });
      const body = report.clipboardText;
      const section = body.indexOf(HEADING);
      const warn = body.indexOf(
        '[2026-09-30T10:00:00.000Z] [warn] [renderer:config] (esta sesión) ×3',
      );
      const error = body.indexOf(
        '[2026-09-29T08:00:00.000Z] [error] [main] (sesión anterior)',
      );
      expect(body.indexOf('### Entorno')).toBeLessThan(section);
      expect(section).toBeLessThan(warn);
      expect(warn).toBeLessThan(error);
      expect(error).toBeLessThan(body.indexOf('LOG-TAIL-LINE'));
      expect(body).toContain('install failed');
    });

    it('redacts a secret inside an error entry, in both sinks', () => {
      const token = `ghp_${'A'.repeat(36)}`;
      const report = prepareIssueReport(ctx, '', {
        problems: [
          entry({
            message: `update failed: token=${token} Bearer abcdefghijklmnopqrstu`,
          }),
        ],
        session: 'NOW',
      });
      for (const body of [report.clipboardText, urlBody(report)]) {
        expect(body).toContain('update failed');
        expect(body).not.toContain(token);
        expect(body).not.toContain('abcdefghijklmnopqrstu');
      }
    });

    it('keeps the errors and gives up the log tail when the budget is tight', () => {
      const log = Array.from({ length: 400 }, (_, i) => `log line ${i}`).join(
        '\n',
      );
      const report = prepareIssueReport({ ...ctx, platform: 'win32' }, log, {
        problems: [entry({ message: 'the one that matters' })],
        session: 'NOW',
      });
      expect(report.url.length).toBeLessThanOrEqual(MAX_URL_CHARS_WINDOWS);
      const body = urlBody(report);
      expect(body).toContain('the one that matters');
      // The clipboard keeps the whole tail regardless.
      expect(report.clipboardText).toContain('log line 399');
    });

    it('carries only as many entries as fit, and says how many stayed behind', () => {
      const problems = Array.from({ length: 50 }, (_, i) =>
        entry({ message: `failure number ${i} ${'x'.repeat(200)}` }),
      );
      const report = prepareIssueReport({ ...ctx, platform: 'win32' }, '', {
        problems,
        session: 'NOW',
      });
      expect(report.url.length).toBeLessThanOrEqual(MAX_URL_CHARS_WINDOWS);
      const body = urlBody(report);
      // Newest first: the last recorded failure is the one that rides along.
      expect(body).toContain('failure number 49');
      expect(body).not.toContain('failure number 0 ');
      expect(body).toMatch(/y \d+ más en el portapapeles/);
      // The clipboard carries every entry.
      expect(report.clipboardText).toContain('failure number 0 ');
      expect(report.clipboardText).not.toContain('más en el portapapeles');
    });

    it('shortens a long entry in the URL but not on the clipboard', () => {
      const long = `stack start\n${'at frame\n'.repeat(80)}stack end`;
      const report = prepareIssueReport(ctx, '', {
        problems: [entry({ message: long })],
        session: 'NOW',
      });
      expect(report.clipboardText).toContain('stack end');
      expect(urlBody(report)).toContain('stack start');
      expect(urlBody(report)).not.toContain('stack end');
    });

    it('adds the previous session log tail to the clipboard only', () => {
      const report = prepareIssueReport(ctx, 'current', {
        problems: [],
        session: 'NOW',
        previousLog: 'line from the crashed run',
      });
      expect(report.clipboardText).toContain(
        '### Log de la sesión anterior (últimas líneas)',
      );
      expect(report.clipboardText).toContain('line from the crashed run');
      expect(urlBody(report)).not.toContain('line from the crashed run');
    });

    it('keeps an entry full of fences inside its code block', () => {
      const report = prepareIssueReport(ctx, '', {
        problems: [entry({ message: 'quoted ``` fence' })],
        session: 'NOW',
      });
      expect(report.clipboardText).toContain('````text');
    });
  });

  describe('countProblems', () => {
    it('counts errors and warnings separately', () => {
      expect(
        countProblems([
          entry(),
          entry({ level: 'warn' }),
          entry({ level: 'warn' }),
        ]),
      ).toEqual({ errors: 1, warnings: 2 });
    });
  });
});
