import fs from 'node:fs';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

/**
 * Stream a URL to `dest`, following GitHub's asset redirects. Separate from the
 * updater so the redirect rules — which are the security-relevant part — have
 * one home: a Location header MAY be a relative reference (RFC 7231), and the
 * updater must never leave https.
 */
export function downloadFile(
  url: string,
  dest: string,
  redirects = 5,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'DevBar-Updater' } },
      (res) => {
        const { statusCode, headers } = res;
        if (
          statusCode !== undefined &&
          [301, 302, 303, 307, 308].includes(statusCode) &&
          typeof headers.location === 'string'
        ) {
          res.resume();
          if (redirects <= 0) return reject(new Error('too many redirects'));
          let next: URL;
          try {
            next = new URL(headers.location, url);
          } catch {
            return reject(new Error('invalid redirect location'));
          }
          if (next.protocol !== 'https:')
            return reject(new Error(`insecure redirect to ${next.protocol}`));
          return resolve(downloadFile(next.href, dest, redirects - 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        // pipeline (not res.pipe): a response-stream failure (server/CDN abort
        // mid-body) must REJECT this promise — plain pipe leaves it pending
        // until the 120 s request timeout, blocking the update fallback
        // handlers — and would surface as an unhandled 'error'.
        void pipeline(res, file).then(() => resolve(dest), reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}
