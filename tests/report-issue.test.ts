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

describe('hostile log content', () => {
  it('never cuts a surrogate pair at the char boundary', () => {
    // The cut lands exactly between the two halves of 😀: the old code
    // kept a lone low surrogate and encodeURIComponent threw URIError,
    // killing the whole report flow.
    const log = `${'a'.repeat(2999)}😀${'b'.repeat(2999)}`;
    let report: ReturnType<typeof prepareIssueReport>;
    expect(() => {
      report = prepareIssueReport(ctx, log);
    }).not.toThrow();
    expect(() => encodeURIComponent(report!.url)).not.toThrow();
    // The clipboard tail (12000 chars, no cut) keeps the emoji intact.
    expect(report!.clipboardText).toContain('😀');
  });

  it('keeps a log full of markdown fences inside the code block', () => {
    const log = 'antes\n```\ntexto ``` anidado\n```\ndespués';
    const body = buildIssueBody(ctx, log);
    // Longest backtick run in the log is 3: the fence must be 4.
    expect(body).toContain('````text');
    expect(body.trim().endsWith('````')).toBe(true);
    // The log survives verbatim, fences and all.
    expect(body).toContain(log);
  });

  it('keeps the plain ``` fence for logs without backticks', () => {
    const body = buildIssueBody(ctx, 'linea uno\nlinea dos');
    expect(body).toContain('```text\nlinea uno');
    expect(body.trim().endsWith('```')).toBe(true);
  });
});

describe('secret redaction at the export boundary', () => {
  const secrets = [
    'ghp_0123456789abcdefghijklmnopqrst',
    'github_pat_11ABCDEFG0123456789_0123456789abcdefghijklmnopqrstuvwx',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1',
    'authorization: Bearer abcdef0123456789abcdef',
    'https://mari:supersecret@internal.example.com/repo',
    'password=hunter2 --token 1234567890abcdef --api-key=zzzz1234567890',
    'digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ];

  // Assembled from parts on purpose: written whole, these fixtures look
  // enough like the real thing that GitHub's secret scanning refuses the
  // push — which is a fair verdict on how realistic they are, and exactly
  // why they exercise the patterns. Splitting the prefix keeps the literal
  // out of the file while the value the test builds is unchanged.
  const SLACK_PREFIX = `xo${'xb'}`;
  const STRIPE_PREFIX = `sk${'_live'}`;
  const NPM_PREFIX = `np${'m_'}`;
  const GOOGLE_PREFIX = `AI${'zaSy'}`;

  // Shapes a dev-tool log plausibly carries that the first pass missed: a
  // service launcher's most likely secret is a connection string, and a
  // vendor token often travels with no key name beside it.
  const moreSecrets = [
    'DATABASE_URL=postgres://admin:s3cr3tpass@db.internal:5432/app',
    'conectando a mysql://root:tigerpass@127.0.0.1/db',
    'redis://default:MyR3disPass@cache:6379',
    'mongodb+srv://u:P4ssw0rdLargo@cluster.mongodb.net',
    `SLACK_BOT=${SLACK_PREFIX}-1234567890-0987654321-AbCdEfGhIjKlMnOpQrSt`,
    `${NPM_PREFIX}AbCdEf0123456789AbCdEf0123456789AbCd`,
    `${GOOGLE_PREFIX}A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q`,
    `${STRIPE_PREFIX}_51AbCdEfGhIjKlMnOpQrStUvWx`,
    'aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    'GITHUB_TOKEN=abcdefghijklmnopqrst',
    'DB_PASSWORD=lacontrasenaentera',
  ];

  it('strips connection strings, vendor tokens and prefixed key names', () => {
    const log = `arranco\n${moreSecrets.join('\n')}\nsigo`;
    const report = prepareIssueReport(ctx, log);
    for (const secret of [
      's3cr3tpass',
      'tigerpass',
      'MyR3disPass',
      'P4ssw0rdLargo',
      'AbCdEfGhIjKlMnOpQrSt',
      `${NPM_PREFIX}AbCdEf0123456789`,
      `${GOOGLE_PREFIX}A1B2C3D4E5F6`,
      `${STRIPE_PREFIX}_51AbCdEfGhIjKl`,
      'wJalrXUtnFEMIK7MDENG',
      'abcdefghijklmnopqrst',
      'lacontrasenaentera',
    ]) {
      expect(report.clipboardText, secret).not.toContain(secret);
      expect(report.url, secret).not.toContain(encodeURIComponent(secret));
    }
    // The surrounding log still reads.
    expect(report.clipboardText).toContain('arranco');
    expect(report.clipboardText).toContain('sigo');
  });

  it('removes a PEM private key block whole', () => {
    const log = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAxyzABCDEFGHIJKLMNOP',
      'QRSTUVWXYZ0123456789abcdefghijklmn',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const report = prepareIssueReport(ctx, log);
    expect(report.clipboardText).not.toContain('MIIEpAIBAAKCAQEAxyz');
    expect(report.clipboardText).toContain('[clave privada]');
  });

  it('leaves prose alone that merely names a secret', () => {
    // A bare `key value` rule would turn these into "token [redacted]" and
    // strip the log of the words that explain the failure. The value has to
    // look like key material before it is treated as one.
    const log = [
      'error: token expired at 12:00',
      'auth failed: password incorrect',
      'no secret configured for this group',
    ].join('\n');
    const report = prepareIssueReport(ctx, log);
    expect(report.clipboardText).toContain('token expired');
    expect(report.clipboardText).toContain('password incorrect');
    expect(report.clipboardText).toContain('no secret configured');
  });

  it('strips known secret shapes from BOTH export sinks', () => {
    const log = `arranco\n${secrets.join('\n')}\nsigo`;
    const report = prepareIssueReport(ctx, log);
    for (const secret of secrets) {
      expect(report.clipboardText, secret).not.toContain(secret);
      expect(report.url, secret).not.toContain(
        encodeURIComponent(secret.slice(0, 20)),
      );
    }
    // The placeholders show something happened, and the report structure
    // (plus the innocent lines) survives.
    expect(report.clipboardText).toContain('[token de GitHub]');
    expect(report.clipboardText).toContain('[redacted]');
    expect(report.clipboardText).toContain('arranco');
  });

  it('redacts CLI flags with a space value and quoted or JSON values', () => {
    const log = [
      '--api-key sk_live_ABCDEF123456',
      'token="sk_live_XYZ987654321"',
      '"password":"secret-value-001"',
      "--secret 'otro-valor-999'",
      '{"api_key":"json-key-424242"}',
      'arranque normal',
    ].join('\n');
    const report = prepareIssueReport(ctx, log);
    for (const secret of [
      'sk_live_ABCDEF123456',
      'sk_live_XYZ987654321',
      'secret-value-001',
      'otro-valor-999',
      'json-key-424242',
    ]) {
      expect(report.clipboardText).not.toContain(secret);
      expect(report.url).not.toContain(encodeURIComponent(secret));
    }
    // The keys stay legible: only the values become placeholders.
    expect(report.clipboardText).toContain('--api-key [redacted]');
    expect(report.clipboardText).toContain('token=[redacted]');
    expect(report.clipboardText).toContain('"password":[redacted]');
    expect(report.clipboardText).toContain('--secret [redacted]');
    expect(report.clipboardText).toContain('"api_key":[redacted]');
    // The innocent line survives.
    expect(report.clipboardText).toContain('arranque normal');
  });

  it('consumes an authorization scheme together with its credential', () => {
    const log = [
      'Authorization: Basic dXNlcjpwYXNz',
      '--auth Basic Ym9iOnNlY3JldDEyMzQ=',
      'token: Bearer eyhbGciOiJIUzI1NiJ9.xx.yy',
      'petición normal',
    ].join('\n');
    const report = prepareIssueReport(ctx, log);
    for (const credential of [
      'dXNlcjpwYXNz',
      'Ym9iOnNlY3JldDEyMzQ=',
      'eyhbGciOiJIUzI1NiJ9',
    ]) {
      expect(report.clipboardText).not.toContain(credential);
      expect(report.url).not.toContain(encodeURIComponent(credential));
    }
    expect(report.clipboardText).toContain('Authorization: [redacted]');
    expect(report.clipboardText).toContain('--auth [redacted]');
    expect(report.clipboardText).toContain('token: [redacted]');
    expect(report.clipboardText).toContain('petición normal');
  });

  it('turns absolute home paths into ~ in both export sinks', () => {
    const log = [
      '[logger] Log session started → /home/juanjo/.config/DevBar/logs/app.log (cap 5242880 bytes)',
      'config en C:\\Users\\juanjo\\AppData\\DevBar\\config.json',
      'ver https://example.com/home/public para más datos',
    ].join('\n');
    const report = prepareIssueReport(ctx, log);
    expect(report.clipboardText).toContain('~/.config/DevBar/logs/app.log');
    expect(report.clipboardText).toContain('~\\AppData');
    // The username need not reach a public issue (the URL check targets
    // the home path: the repo owner in ISSUES_URL shares the name).
    expect(report.clipboardText).not.toContain('/home/juanjo');
    expect(report.clipboardText).not.toContain('C:\\Users\\juanjo');
    expect(report.url).not.toContain(encodeURIComponent('/home/juanjo'));
    expect(report.url).not.toContain(encodeURIComponent('C:\\Users\\juanjo'));
    // A URL PATH is not a filesystem path: untouched.
    expect(report.clipboardText).toContain('https://example.com/home/public');
  });

  it('redacts query-string and CLI-assignment secrets', () => {
    const log = [
      'https://example.test/path?token=query-secret',
      'https://example.test/path?a=1&api_key=second-secret',
      '--api-key=cli-secret',
      'enlace inocuo https://example.test/plain',
    ].join('\n');
    const report = prepareIssueReport(ctx, log);
    for (const secret of ['query-secret', 'second-secret', 'cli-secret']) {
      expect(report.clipboardText, secret).not.toContain(secret);
      expect(report.url, secret).not.toContain(encodeURIComponent(secret));
    }
    // The delimiters stay legible: only the values become placeholders.
    expect(report.clipboardText).toContain('?token=[redacted]');
    expect(report.clipboardText).toContain('&api_key=[redacted]');
    expect(report.clipboardText).toContain('--api-key=[redacted]');
    expect(report.clipboardText).toContain(
      'enlace inocuo https://example.test/plain',
    );
  });

  it('leaves ordinary log lines untouched', () => {
    const log = '12:00 start pnpm -v\nexit 0\nreintentando servicio web';
    const report = prepareIssueReport(ctx, log);
    expect(report.clipboardText).toContain(log);
  });

  it('redacts before the char budget, so no cut can split a placeholder', () => {
    const log = `${'x'.repeat(2950)}\ntoken ${'a'.repeat(40)}`;
    const report = prepareIssueReport(ctx, log);
    // The raw 40-char token must not survive even partially.
    expect(report.clipboardText).not.toContain('a'.repeat(40));
  });
});

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
