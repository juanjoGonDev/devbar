'use strict';

/**
 * update-check.js — checks the latest GitHub release against the running
 * version. The app is unsigned, so true silent auto-update (Squirrel.Mac)
 * is not available; this just notifies and links to the download.
 * ponytail: notify-only, swap for update.electronjs.org if the app ever
 * gets code-signed + notarized.
 */

const https = require('node:https');

function parseVersion(v) {
  return String(v || '')
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

/** True if `latest` is a higher semver than `current` (numeric, 3-part). */
function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Resolve to { version, url } when GitHub's latest release is newer than
 * `currentVersion`, else null. Never rejects — any failure resolves null.
 */
function checkForUpdate({ owner, repo, currentVersion, timeoutMs = 8000 }) {
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
          return resolve(null);
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const r = JSON.parse(data);
            const version = String(r.tag_name || '').replace(/^v/, '');
            resolve(
              version && isNewerVersion(version, currentVersion)
                ? { version, url: r.html_url }
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

module.exports = { isNewerVersion, checkForUpdate };
