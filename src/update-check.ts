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
export function selectAssetUrl(
  assets: unknown,
  arch: string,
  ext: string,
): string | null {
  if (!Array.isArray(assets)) return null;
  const suffix = `macos-${arch}.${ext}`;
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
  timeoutMs?: number;
}
export function checkForUpdate({
  owner,
  repo,
  currentVersion,
  arch = process.arch,
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
              version = String(release.tag_name ?? '').replace(/^v/, '');
            resolve(
              version && isNewerVersion(version, currentVersion)
                ? {
                    version,
                    url:
                      typeof release.html_url === 'string'
                        ? release.html_url
                        : '',
                    dmgUrl: selectAssetUrl(release.assets, arch, 'dmg'),
                    zipUrl: selectAssetUrl(release.assets, arch, 'zip'),
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
export function parseReleases(value: unknown, limit = 5): ReleaseSummary[] {
  if (!Array.isArray(value)) return [];
  return value
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
          typeof release.published_at === 'string' ? release.published_at : '',
        prerelease: Boolean(release.prerelease),
      };
    });
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
