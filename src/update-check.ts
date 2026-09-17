import https from 'node:https';
import type { AvailableUpdate, ReleaseSummary } from './domain-types.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function parseVersion(value: unknown): number[] {
  return String(value ?? '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest),
    b = parseVersion(current),
    len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Release asset naming, one family per platform. The CI release workflow
 * emits exactly these, so in-app update selection and the release validator
 * both derive from `expectedReleaseArtifactNames`-style suffixes.
 */
/**
 * Node reports 32-bit ARM as `arm`, but the release artifacts are named
 * `linux-armv7.*` (electron-builder's target name) — without this, a
 * 32-bit Raspberry Pi would look for `linux-arm.*` and get no in-place
 * update URLs. `arm64` is already the release naming and stays unchanged.
 */
export function normalizeArch(platform: NodeJS.Platform, arch: string): string {
  return platform === 'linux' && arch === 'arm' ? 'armv7' : arch;
}
export function releaseAssetSuffixes(
  platform: NodeJS.Platform,
  arch: string,
): {
  dmg?: string;
  zip?: string;
  setup?: string;
  appImage?: string;
  deb?: string;
} {
  // DevBar ships for exactly these three platforms (Raspberry Pi = linux).
  // Anything else gets no artifacts at all: selecting the "closest"
  // platform would offer installers the system cannot use.
  arch = normalizeArch(platform, arch);
  if (platform === 'darwin')
    return { dmg: `macos-${arch}.dmg`, zip: `macos-${arch}.zip` };
  if (platform === 'win32')
    return {
      setup: `win-${arch}-setup.exe`,
      zip: `win-${arch}-portable.exe`,
    };
  if (platform === 'linux')
    return {
      appImage: `linux-${arch}.AppImage`,
      deb: `linux-${arch}.deb`,
    };
  return {};
}

export function selectAssetUrl(assets: unknown, suffix: string): string | null {
  // An empty suffix must never match: `endsWith('')` is true for every
  // name, which would hand the FIRST asset of the release to any URL
  // field the current platform does not use (a Linux box would be
  // offered the .dmg as its "setup").
  if (!Array.isArray(assets) || suffix === '') return null;
  for (const candidate of assets) {
    const asset = record(candidate);
    if (
      typeof asset.name === 'string' &&
      asset.name.endsWith(suffix) &&
      typeof asset.browser_download_url === 'string'
    )
      return asset.browser_download_url;
  }
  return null;
}

export interface UpdateCheckOptions {
  owner: string;
  repo: string;
  currentVersion: string;
  arch?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export function checkForUpdate({
  owner,
  repo,
  currentVersion,
  arch = process.arch,
  platform = process.platform,
  timeoutMs = 8000,
}: UpdateCheckOptions): Promise<AvailableUpdate | null> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/releases/latest`,
        headers: {
          'User-Agent': 'DevBar-UpdateCheck',
          Accept: 'application/vnd.github+json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        // Same protection as httpGetText: a socket failure AFTER the
        // headers (mid-body reset, or a non-200 body drained by resume())
        // emits on the IncomingMessage, not the request — without this
        // handler it would be unhandled and crash the app during an
        // update.
        res.on('error', () => resolve(null));
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            const raw: unknown = JSON.parse(data),
              release = record(raw),
              version = String(release.tag_name ?? '').replace(/^v/, ''),
              suffixes = releaseAssetSuffixes(platform, arch);
            resolve(
              version && isNewerVersion(version, currentVersion)
                ? {
                    version,
                    url:
                      typeof release.html_url === 'string'
                        ? release.html_url
                        : '',
                    dmgUrl: selectAssetUrl(release.assets, suffixes.dmg ?? ''),
                    zipUrl: selectAssetUrl(release.assets, suffixes.zip ?? ''),
                    setupUrl: selectAssetUrl(
                      release.assets,
                      suffixes.setup ?? '',
                    ),
                    appImageUrl: selectAssetUrl(
                      release.assets,
                      suffixes.appImage ?? '',
                    ),
                    debUrl: selectAssetUrl(release.assets, suffixes.deb ?? ''),
                  }
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * GET a URL (following GitHub's asset redirects) into text, or null on any
 * failure. Used for the SHA256SUMS.txt integrity manifest — the only trust
 * anchor an unsigned-download update has.
 */
function httpGetText(
  url: string,
  timeoutMs = 20000,
  redirects = 5,
): Promise<string | null> {
  return new Promise((resolve) => {
    let remaining = redirects;
    const fetchOnce = (target: string) => {
      const request = https.get(
        target,
        { headers: { 'User-Agent': 'DevBar-Updater' } },
        (res) => {
          // A socket failure AFTER the headers (e.g. mid-body reset, or a
          // failed redirect/non-200 body being drained by resume()) emits
          // on the IncomingMessage, not the request — without a handler at
          // the TOP it would be unhandled and crash the app during an
          // update.
          res.on('error', () => resolve(null));
          const status = res.statusCode;
          if (
            status !== undefined &&
            [301, 302, 303, 307, 308].includes(status) &&
            typeof res.headers.location === 'string'
          ) {
            res.resume();
            if (remaining <= 0) return resolve(null);
            remaining -= 1;
            return fetchOnce(res.headers.location);
          }
          if (status !== 200) {
            res.resume();
            return resolve(null);
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => resolve(data));
        },
      );
      request.on('error', () => resolve(null));
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        resolve(null);
      });
    };
    fetchOnce(url);
  });
}

/**
 * `name → sha256` for the release that carries `version`. Returns null when
 * the release or its manifest cannot be fetched.
 */
export async function fetchReleaseSha256(
  owner: string,
  repo: string,
  version: string,
): Promise<Map<string, string> | null> {
  const text = await httpGetText(
    `https://github.com/${owner}/${repo}/releases/download/v${version}/SHA256SUMS.txt`,
  );
  if (text === null) return null;
  const entries = new Map<string, string>();
  for (const line of text.split(/[\r\n]+/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) entries.set(match[2], match[1]);
  }
  return entries.size > 0 ? entries : null;
}

export function parseReleases(value: unknown, limit = 5): ReleaseSummary[] {
  return Array.isArray(value)
    ? value
        .filter((candidate) => record(candidate).draft !== true)
        .slice(0, limit)
        .map((candidate) => {
          const release = record(candidate);
          return {
            version: String(release.tag_name ?? '').replace(/^v/, ''),
            name: typeof release.name === 'string' ? release.name : '',
            body: typeof release.body === 'string' ? release.body : '',
            url: typeof release.html_url === 'string' ? release.html_url : '',
            publishedAt:
              typeof release.published_at === 'string'
                ? release.published_at
                : '',
            prerelease: Boolean(release.prerelease),
          };
        })
    : [];
}

export function fetchReleases({
  owner,
  repo,
  limit = 5,
  timeoutMs = 8000,
}: {
  owner: string;
  repo: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<ReleaseSummary[]> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/releases?per_page=${limit}`,
        headers: {
          'User-Agent': 'DevBar-UpdateCheck',
          Accept: 'application/vnd.github+json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        // A mid-body failure (ECONNRESET/timeout) emits 'error' on the
        // RESPONSE, not on req — without a listener it would be an
        // unhandled 'error' event that crashes the main process.
        res.on('error', () => resolve([]));
        if (res.statusCode !== 200) {
          res.resume();
          resolve([]);
          return;
        }
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            // The API call asked for `limit` entries (per_page) — the
            // parse must honor the same limit, not its own default of 5.
            resolve(parseReleases(JSON.parse(data) as unknown, limit));
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}
