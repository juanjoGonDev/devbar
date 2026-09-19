import { describe, expect, it } from 'vitest';
import {
  buildIssueBody,
  CLIPBOARD_TAIL_CHARS,
  CLIPBOARD_TAIL_LINES,
  issueTitle,
  keepTail,
  MAX_URL_CHARS,
  MAX_URL_CHARS_WINDOWS,
  maxUrlCharsFor,
  prepareIssueReport,
  URL_TAIL_CHARS,
  URL_TAIL_LINES,
} from '../src/report-issue.js';

const ctx = {
  version: '0.9.3',
  platform: 'linux',
  arch: 'arm64',
  electron: '43.2.0',
  node: '22.22.3',
  osRelease: '6.12.34+rpt-rpi-2712',
};

describe('URL budget per platform', () => {
  it('caps Windows under its 2081-char openExternal limit', () => {
    expect(MAX_URL_CHARS_WINDOWS).toBeLessThanOrEqual(2000);
    expect(maxUrlCharsFor('win32')).toBe(MAX_URL_CHARS_WINDOWS);
  });

  it('keeps the generous form limit on the other desktops', () => {
    expect(maxUrlCharsFor('linux')).toBe(MAX_URL_CHARS);
    expect(maxUrlCharsFor('darwin')).toBe(MAX_URL_CHARS);
  });

  it('falls back to the clipboard on Windows past the small budget', () => {
    const log = 'x'.repeat(1800);
    const win = prepareIssueReport({ ...ctx, platform: 'win32' }, log);
    expect(win.bodyIncluded).toBe(false);
    expect(win.url).not.toContain('body=');
    // Nothing is lost: the clipboard still carries the full report.
    expect(win.clipboardText).toContain(log);
    // The same report fits the URL budget on Linux.
    const linux = prepareIssueReport({ ...ctx, platform: 'linux' }, log);
    expect(linux.bodyIncluded).toBe(true);
    expect(linux.url).toContain('body=');
  });

  it('still pre-fills the form on Windows when the URL fits', () => {
    const win = prepareIssueReport({ ...ctx, platform: 'win32' }, 'ok');
    expect(win.bodyIncluded).toBe(true);
    expect(win.url.length).toBeLessThanOrEqual(MAX_URL_CHARS_WINDOWS);
  });
});

describe('src/report-issue.ts', () => {
  describe('keepTail', () => {
    it('keeps the most recent lines', () => {
      const log = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      expect(keepTail(log, 3, 10_000)).toBe('line 7\nline 8\nline 9');
    });

    it('caps the size again from the end', () => {
      const tail = keepTail('a'.repeat(50) + '|end', 100, 4);
      expect(tail).toBe('|end');
    });

    it('answers empty for a missing log', () => {
      expect(keepTail(null, 10, 10)).toBe('');
      expect(keepTail('', 10, 10)).toBe('');
    });
  });

  describe('buildIssueBody', () => {
    it('carries the environment and a fenced log tail', () => {
      const body = buildIssueBody(ctx, '12:00 start pnpm -v\nexited 0');
      expect(body).toContain('(describe el problema)');
      expect(body).toContain('- DevBar: 0.9.3');
      expect(body).toContain('- Sistema: linux arm64 (6.12.34+rpt-rpi-2712)');
      expect(body).toContain('- Electron 43.2.0 / Node 22.22.3');
      expect(body).toContain('```text\n12:00 start pnpm -v\nexited 0\n```');
    });

    it('omits the log section when there is no tail', () => {
      expect(buildIssueBody(ctx, '')).not.toContain('Log de la app');
    });
  });

  describe('issueTitle', () => {
    it('names the app, version and platform', () => {
      expect(issueTitle(ctx)).toBe(
        'Reporte de fallo — DevBar 0.9.3 (linux-arm64)',
      );
    });
  });

  describe('prepareIssueReport', () => {
    it('pre-fills the GitHub form and copies a fuller report', () => {
      const report = prepareIssueReport(ctx, 'warn line\nerror line');
      expect(
        report.url.startsWith(
          'https://github.com/juanjoGonDev/devbar/issues/new?title=',
        ),
      ).toBe(true);
      expect(report.url).toContain('body=');
      expect(report.bodyIncluded).toBe(true);
      // The clipboard carries the full report even when the URL fits.
      expect(report.clipboardText).toContain('warn line');
      expect(report.clipboardText).toContain('Entorno');
    });

    it('falls back to title-only when the body would not fit the URL', () => {
      // Content that percent-encodes heavily (non-ASCII, like the Spanish
      // text real logs carry) blows the URL budget well before the plain
      // character cap would suggest.
      const huge: string[] = [];
      for (let i = 0; i < URL_TAIL_LINES + 10; i++)
        huge.push(`L${i}: ` + 'ñ'.repeat(200));
      const report = prepareIssueReport(ctx, huge.join('\n'));
      expect(report.url).not.toContain('body=');
      expect(report.bodyIncluded).toBe(false);
      // The URL stays within budget regardless.
      expect(report.url.length).toBeLessThan(MAX_URL_CHARS);
      // And the clipboard still carries the big tail, capped to its budget.
      const tail = report.clipboardText.split('```text')[1] ?? '';
      expect(tail.length).toBeLessThanOrEqual(CLIPBOARD_TAIL_CHARS + 20);
    });

    it('keeps the url and clipboard tails to their declared budgets', () => {
      const lines: string[] = [];
      for (let i = 0; i < CLIPBOARD_TAIL_LINES + 50; i++)
        lines.push(`line-${i}`);
      const report = prepareIssueReport(ctx, lines.join('\n'));
      const urlTail = decodeURIComponent(
        (report.url.match(/body=([^&]+)/) ?? ['', ''])[1] ?? '',
      );
      expect(urlTail).toContain(`line-${CLIPBOARD_TAIL_LINES + 49}`);
      // URL body bounded by URL_TAIL_*, never by the clipboard budget.
      expect(urlTail.length).toBeLessThanOrEqual(URL_TAIL_CHARS + 40);
    });
  });
});
