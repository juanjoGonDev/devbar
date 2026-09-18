import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import { Readable } from 'node:stream';
import {
  isNewerVersion,
  selectAssetUrl,
  parseReleases,
  releaseAssetSuffixes,
  normalizeArch,
  fetchReleases,
  fetchReleaseSha256,
  checkForUpdate,
} from '../src/update-check.js';

describe('isNewerVersion', () => {
  it('detects a higher patch/minor/major', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('is false for equal or older', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
  });

  it('ignores a leading v and ragged lengths', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.1', '0.1.0')).toBe(false);
  });
});

describe('releaseAssetSuffixes', () => {
  it('maps each platform to its installer family', () => {
    expect(releaseAssetSuffixes('darwin', 'arm64')).toEqual({
      dmg: 'macos-arm64.dmg',
      zip: 'macos-arm64.zip',
    });
    expect(releaseAssetSuffixes('win32', 'x64')).toEqual({
      setup: 'win-x64-setup.exe',
      zip: 'win-x64-portable.exe',
    });
    expect(releaseAssetSuffixes('linux', 'arm64')).toEqual({
      appImage: 'linux-arm64.AppImage',
      deb: 'linux-arm64.deb',
    });
  });

  it('maps Node "arm" to the release naming linux-armv7 (32-bit Pi)', () => {
    expect(releaseAssetSuffixes('linux', 'arm')).toEqual({
      appImage: 'linux-armv7.AppImage',
      deb: 'linux-armv7.deb',
    });
    expect(normalizeArch('linux', 'arm')).toBe('armv7');
    expect(normalizeArch('linux', 'arm64')).toBe('arm64');
    expect(normalizeArch('darwin', 'arm64')).toBe('arm64');
    expect(normalizeArch('win32', 'x64')).toBe('x64');
  });

  it('offers no artifacts for unsupported platforms', () => {
    // DevBar ships for darwin/win32/linux only. Falling back to the
    // "closest" platform would offer installers the system cannot use.
    expect(releaseAssetSuffixes('freebsd', 'x64')).toEqual({});
    expect(releaseAssetSuffixes('aix', 'ppc64')).toEqual({});
  });
});

describe('selectAssetUrl', () => {
  const assets = [
    { name: 'DevBar-0.4.0-macos-arm64.dmg', browser_download_url: 'u/arm.dmg' },
    { name: 'DevBar-0.4.0-macos-arm64.zip', browser_download_url: 'u/arm.zip' },
    { name: 'DevBar-0.4.0-macos-x64.dmg', browser_download_url: 'u/x64.dmg' },
    { name: 'DevBar-0.4.0-macos-x64.zip', browser_download_url: 'u/x64.zip' },
    {
      name: 'DevBar-0.4.0-win-x64-setup.exe',
      browser_download_url: 'u/win-setup',
    },
    {
      name: 'DevBar-0.4.0-win-x64-portable.exe',
      browser_download_url: 'u/win-portable',
    },
    {
      name: 'DevBar-0.4.0-linux-x64.AppImage',
      browser_download_url: 'u/appimage',
    },
    { name: 'DevBar-0.4.0-linux-x64.deb', browser_download_url: 'u/deb' },
    { name: 'checksums.txt', browser_download_url: 'u/checksums' },
  ];

  it('picks the dmg for the given architecture', () => {
    expect(selectAssetUrl(assets, 'macos-arm64.dmg')).toBe('u/arm.dmg');
    expect(selectAssetUrl(assets, 'macos-x64.dmg')).toBe('u/x64.dmg');
  });

  it('picks the zip for the given architecture', () => {
    expect(selectAssetUrl(assets, 'macos-arm64.zip')).toBe('u/arm.zip');
  });

  it('picks the windows and linux installers', () => {
    expect(selectAssetUrl(assets, 'win-x64-setup.exe')).toBe('u/win-setup');
    expect(selectAssetUrl(assets, 'win-x64-portable.exe')).toBe(
      'u/win-portable',
    );
    expect(selectAssetUrl(assets, 'linux-x64.AppImage')).toBe('u/appimage');
    expect(selectAssetUrl(assets, 'linux-x64.deb')).toBe('u/deb');
  });

  it('returns null when no asset matches', () => {
    expect(selectAssetUrl(assets, 'macos-arm64.pkg')).toBe(null);
    expect(selectAssetUrl(assets, 'win-ppc-setup.exe')).toBe(null);
    expect(selectAssetUrl([], 'macos-arm64.dmg')).toBe(null);
    expect(selectAssetUrl(null, 'macos-arm64.dmg')).toBe(null);
  });

  it('never matches on an empty suffix', () => {
    // `endsWith('')` is true for every name: without the guard, an
    // unused URL field (a platform with no such artifact) would
    // receive the FIRST asset of the release.
    expect(selectAssetUrl(assets, '')).toBe(null);
    expect(selectAssetUrl([], '')).toBe(null);
    expect(selectAssetUrl(null, '')).toBe(null);
  });
});

describe('parseReleases', () => {
  const raw = [
    {
      tag_name: 'v0.4.0',
      name: '0.4.0',
      body: 'notes',
      html_url: 'u/4',
      published_at: '2026-08-01T10:00:00Z',
    },
    { tag_name: '0.3.0', body: '', html_url: 'u/3', draft: true },
    { tag_name: 'v0.2.0', html_url: 'u/2', prerelease: true },
  ];

  it('strips leading v, keeps fields, and flags prereleases', () => {
    const out = parseReleases(raw);
    expect(out.map((r) => r.version)).toEqual(['0.4.0', '0.2.0']); // draft skipped
    expect(out[0]).toMatchObject({ body: 'notes', url: 'u/4' });
    expect(out[1].prerelease).toBe(true);
  });

  it('respects the limit and tolerates junk', () => {
    expect(parseReleases(raw, 1)).toHaveLength(1);
    expect(parseReleases(null)).toEqual([]);
    expect(parseReleases(undefined)).toEqual([]);
  });
});

describe('fetchReleases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the requested limit through to the parse step', async () => {
    // The HTTP request asks GitHub for `per_page=limit`; the parse used to
    // silently re-apply its own default of 5, dropping entries 6+.
    const releases = Array.from({ length: 12 }, (_, i) => ({
      tag_name: `v1.0.${i + 1}`,
      name: `release ${i + 1}`,
      body: '',
      html_url: `u/${i + 1}`,
      published_at: '2026-01-01T00:00:00Z',
    }));
    vi.spyOn(https, 'get').mockImplementation(((
      _opts: unknown,
      cb: (res: Readable & { statusCode?: number }) => void,
    ) => {
      const res: Readable & { statusCode?: number } = new Readable({
        read() {},
      });
      res.statusCode = 200;
      setImmediate(() => {
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify(releases)));
        res.emit('end');
      });
      return { on: vi.fn(), destroy: vi.fn() };
    }) as never);
    const out = await fetchReleases({
      owner: 'o',
      repo: 'r',
      limit: 12,
      timeoutMs: 5000,
    });
    expect(out).toHaveLength(12);
    expect(out[0].version).toBe('1.0.1');
  });
});

describe('response error handling (mid-drain socket failures)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('httpGetText: a non-200 body that errors while draining resolves null', async () => {
    // Before the error listener moved to the top of the response callback,
    // the non-200 branch drained the body with resume() and any socket
    // failure there emitted an UNHANDLED 'error' on the IncomingMessage —
    // an uncaught exception that would crash DevBar during an update.
    vi.spyOn(https, 'get').mockImplementation(((
      _url: unknown,
      _opts: unknown,
      cb: (
        res: Readable & {
          statusCode?: number;
          headers?: Record<string, unknown>;
        },
      ) => void,
    ) => {
      const res: Readable & {
        statusCode?: number;
        headers?: Record<string, unknown>;
      } = new Readable({ read() {} });
      res.statusCode = 500;
      res.headers = {};
      setImmediate(() => {
        cb(res);
        setImmediate(() => res.emit('error', new Error('ECONNRESET')));
      });
      return { on: vi.fn(), destroy: vi.fn(), setTimeout: vi.fn() } as never;
    }) as never);
    await expect(fetchReleaseSha256('o', 'r', '1.0.0')).resolves.toBeNull();
  });

  it('fetchReleases: a 200 body that errors mid-stream resolves an empty list', async () => {
    // A mid-body socket failure emits 'error' on the RESPONSE — before the
    // listener moved to the top of the response callback this was an
    // unhandled 'error' event, an uncaught exception that would crash
    // DevBar while it loads release data.
    vi.spyOn(https, 'get').mockImplementation(((
      _opts: unknown,
      cb: (res: Readable & { statusCode?: number }) => void,
    ) => {
      const res: Readable & { statusCode?: number } = new Readable({
        read() {},
      });
      res.statusCode = 200;
      setImmediate(() => {
        cb(res);
        res.emit('data', Buffer.from('["partial'));
        setImmediate(() => res.emit('error', new Error('ECONNRESET')));
      });
      return { on: vi.fn(), destroy: vi.fn() } as never;
    }) as never);
    await expect(
      fetchReleases({ owner: 'o', repo: 'r', timeoutMs: 5000 }),
    ).resolves.toEqual([]);
  });

  it('checkForUpdate: a non-200 body that errors while draining resolves null', async () => {
    vi.spyOn(https, 'get').mockImplementation(((
      _opts: unknown,
      cb: (res: Readable & { statusCode?: number }) => void,
    ) => {
      const res: Readable & { statusCode?: number } = new Readable({
        read() {},
      });
      res.statusCode = 500;
      setImmediate(() => {
        cb(res);
        setImmediate(() => res.emit('error', new Error('ECONNRESET')));
      });
      return { on: vi.fn(), destroy: vi.fn() } as never;
    }) as never);
    await expect(
      checkForUpdate({ owner: 'o', repo: 'r', currentVersion: '0.0.1' }),
    ).resolves.toBeNull();
  });
});

describe('httpGetText: redirect handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // sha256sum format: 64 hex chars, a space separator, then a space (or *) before the name.
  const MANIFEST_LINE = `${'a'.repeat(64)}  SHA256SUMS.txt`;
  const BASE_URL =
    'https://github.com/o/r/releases/download/v1.0.0/SHA256SUMS.txt';

  /**
   * Mocks https.get with a scripted sequence of responses and records
   * every URL requested. Each entry: the status + Location (or 200 with
   * the manifest body) to serve on that call.
   */
  function mockSequence(
    responses: Array<{
      status: number;
      location?: string;
    }>,
  ): string[] {
    const requested: string[] = [];
    vi.spyOn(https, 'get').mockImplementation(((
      url: unknown,
      _opts: unknown,
      cb: (
        res: Readable & {
          statusCode?: number;
          headers?: Record<string, unknown>;
        },
      ) => void,
    ) => {
      const u = String(url);
      requested.push(u);
      const entry = responses[Math.min(requested.length, responses.length) - 1];
      const res: Readable & {
        statusCode?: number;
        headers?: Record<string, unknown>;
      } = new Readable({ read() {} });
      res.statusCode = entry.status;
      res.headers = entry.location ? { location: entry.location } : {};
      setImmediate(() => {
        cb(res);
        if (entry.status === 200) {
          // httpGetText relies on res.setEncoding('utf8'), which a manual
          // emit bypasses — feed the already-encoded string, as a real
          // response would deliver it.
          res.emit('data', MANIFEST_LINE);
          res.emit('end');
        }
      });
      return { on: vi.fn(), destroy: vi.fn(), setTimeout: vi.fn() } as never;
    }) as never);
    return requested;
  }

  it('resolves a relative Location against the target URL', async () => {
    const requested = mockSequence([
      { status: 302, location: './SHA256SUMS.txt' },
      { status: 200 },
    ]);
    const out = await fetchReleaseSha256('o', 'r', '1.0.0');
    // A relative reference must be resolved, never passed raw to
    // https.get (which would fail).
    expect(requested).toEqual([BASE_URL, BASE_URL]);
    expect(out?.size).toBe(1);
  });

  it('follows an absolute https Location', async () => {
    const target = 'https://github.com/o/r/other/SHA256SUMS.txt';
    const requested = mockSequence([
      { status: 301, location: target },
      { status: 200 },
    ]);
    const out = await fetchReleaseSha256('o', 'r', '1.0.0');
    expect(requested).toEqual([BASE_URL, target]);
    expect(out?.size).toBe(1);
  });

  it('rejects a redirect to a non-https protocol', async () => {
    const requested = mockSequence([
      { status: 302, location: 'http://github.com/o/r/SHA256SUMS.txt' },
      { status: 200 },
    ]);
    const out = await fetchReleaseSha256('o', 'r', '1.0.0');
    expect(out).toBeNull();
    // The non-https target must never be requested.
    expect(requested).toEqual([BASE_URL]);
  });

  it('resolves null on a malformed Location', async () => {
    // Unterminated IPv6 host: new URL() throws.
    const requested = mockSequence([
      { status: 302, location: 'https://[::1' },
      { status: 200 },
    ]);
    const out = await fetchReleaseSha256('o', 'r', '1.0.0');
    expect(out).toBeNull();
    expect(requested).toEqual([BASE_URL]);
  });
});
