import fs from 'node:fs';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Bytes on disk so far; `total` is null when the server sent no length. */
interface DownloadProgress {
  received: number;
  total: number | null;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  /** Injectable clock for the throttle (ms). */
  now?: () => number;
  redirects?: number;
}

/** A report at most every this many ms, or on every whole-percent step. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Turns a stream of chunk sizes into throttled progress reports: the first
 * (zero) and the last one always land, and in between one per whole percent
 * or per interval — a 40 MB download arrives in thousands of chunks, and each
 * report is an IPC push to every window.
 */
function progressReporter(
  total: number | null,
  onProgress: (progress: DownloadProgress) => void,
  now: () => number,
): { add: (bytes: number) => void; finish: () => void } {
  let received = 0;
  let lastAt = now();
  let lastPercent = 0;
  let lastReported = -1;
  const report = (): void => {
    lastReported = received;
    onProgress({ received, total });
  };
  report();
  return {
    add(bytes) {
      received += bytes;
      const at = now();
      const percent = total ? Math.floor((received / total) * 100) : 0;
      if (at - lastAt >= PROGRESS_INTERVAL_MS || percent > lastPercent) {
        lastAt = at;
        lastPercent = percent;
        report();
      }
    },
    finish() {
      if (lastReported !== received) report();
    },
  };
}

function contentLength(value: string | string[] | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Stream a URL to `dest`, following GitHub's asset redirects. Separate from the
 * updater so the redirect rules — which are the security-relevant part — have
 * one home: a Location header MAY be a relative reference (RFC 7231), and the
 * updater must never leave https.
 */
export function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<string> {
  const redirects = options.redirects ?? 5;
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
          return resolve(
            downloadFile(next.href, dest, {
              ...options,
              redirects: redirects - 1,
            }),
          );
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        const { onProgress } = options;
        const progress = onProgress
          ? progressReporter(
              contentLength(headers['content-length']),
              onProgress,
              options.now ?? Date.now,
            )
          : null;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            progress?.add(chunk.length);
            done(null, chunk);
          },
        });
        // pipeline (not res.pipe): a response-stream failure (server/CDN abort
        // mid-body) must REJECT this promise — plain pipe leaves it pending
        // until the 120 s request timeout, blocking the update fallback
        // handlers — and would surface as an unhandled 'error'.
        void pipeline(res, counter, file).then(() => {
          progress?.finish();
          resolve(dest);
        }, reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}
