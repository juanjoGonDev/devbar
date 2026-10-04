import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../src/main/download-file.js';

interface ScriptedResponse {
  status: number;
  location?: string;
  body?: string;
  /** Sent in order instead of `body`, one push per chunk. */
  chunks?: string[];
  /** Advertised as content-length. */
  length?: number;
  failMidBody?: boolean;
}

interface FakeRequest {
  on: (event: string, listener: (error: Error) => void) => FakeRequest;
  setTimeout: (ms: number, listener: () => void) => FakeRequest;
  destroy: (error?: Error) => void;
}

let dir: string;
let requested: string[];

/**
 * Replaces https.get with a scripted sequence and records the URLs asked for,
 * so the redirect rules can be exercised without a network.
 */
function script(responses: ScriptedResponse[], onRequest?: () => void): void {
  let index = 0;
  vi.spyOn(https, 'get').mockImplementation(((
    url: string,
    _opts: unknown,
    cb: (
      res: Readable & { statusCode?: number; headers: Record<string, unknown> },
    ) => void,
  ) => {
    requested.push(url);
    const spec = responses[index++] ?? { status: 200, body: '' };
    const res = new Readable({ read() {} }) as Readable & {
      statusCode?: number;
      headers: Record<string, unknown>;
    };
    res.statusCode = spec.status;
    res.headers = {
      ...(spec.location ? { location: spec.location } : {}),
      ...(spec.length !== undefined
        ? { 'content-length': String(spec.length) }
        : {}),
    };
    setImmediate(() => {
      cb(res);
      if (spec.failMidBody) {
        res.destroy(new Error('ECONNRESET'));
        return;
      }
      if (spec.status === 200)
        for (const chunk of spec.chunks ?? [spec.body ?? 'payload'])
          res.push(chunk);
      res.push(null);
    });
    onRequest?.();
    const request: FakeRequest = {
      on: () => request,
      setTimeout: () => request,
      destroy: () => undefined,
    };
    return request;
  }) as never);
}

describe('src/main/download-file.ts', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-download-'));
    requested = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('downloadFile', () => {
    it('writes the body to the destination and resolves its path', async () => {
      script([{ status: 200, body: 'DevBar bytes' }]);
      const dest = path.join(dir, 'artifact.zip');
      await expect(
        downloadFile('https://github.test/a.zip', dest),
      ).resolves.toBe(dest);
      expect(fs.readFileSync(dest, 'utf8')).toBe('DevBar bytes');
    });

    it('follows an absolute https redirect', async () => {
      script([
        { status: 302, location: 'https://cdn.test/a.zip' },
        { status: 200, body: 'ok' },
      ]);
      await downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'));
      expect(requested).toEqual([
        'https://github.test/a.zip',
        'https://cdn.test/a.zip',
      ]);
    });

    it('resolves a relative Location against the current URL', async () => {
      script([
        { status: 307, location: '/other/a.zip' },
        { status: 200, body: 'ok' },
      ]);
      await downloadFile(
        'https://github.test/releases/a.zip',
        path.join(dir, 'a.zip'),
      );
      expect(requested[1]).toBe('https://github.test/other/a.zip');
    });

    it('refuses to leave https', async () => {
      script([{ status: 302, location: 'http://cdn.test/a.zip' }]);
      await expect(
        downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip')),
      ).rejects.toThrow(/insecure redirect to http:/);
      expect(requested).toHaveLength(1);
    });

    it('rejects an unparseable Location', async () => {
      script([{ status: 302, location: 'https://[::1' }]);
      await expect(
        downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip')),
      ).rejects.toThrow('invalid redirect location');
    });

    it('gives up after too many redirects', async () => {
      script(
        Array.from({ length: 8 }, () => ({
          status: 302,
          location: 'https://cdn.test/a.zip',
        })),
      );
      await expect(
        downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), {
          redirects: 2,
        }),
      ).rejects.toThrow('too many redirects');
    });

    it('rejects a non-200 response', async () => {
      script([{ status: 404 }]);
      await expect(
        downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip')),
      ).rejects.toThrow('HTTP 404');
    });

    it('rejects when the body fails mid-stream instead of hanging', async () => {
      script([{ status: 200, failMidBody: true }]);
      await expect(
        downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip')),
      ).rejects.toThrow(/ECONNRESET/);
    });
  });

  describe('progress', () => {
    it('reports the bytes received against the advertised length', async () => {
      script([{ status: 200, chunks: ['ab', 'cd', 'ef'], length: 6 }]);
      const reports: { received: number; total: number | null }[] = [];
      await downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), {
        onProgress: (progress) => reports.push(progress),
      });
      expect(reports[0]).toEqual({ received: 0, total: 6 });
      expect(reports.at(-1)).toEqual({ received: 6, total: 6 });
    });

    it('reports an unknown total when the server sends no length', async () => {
      script([{ status: 200, body: 'abc' }]);
      const reports: { received: number; total: number | null }[] = [];
      await downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), {
        onProgress: (progress) => reports.push(progress),
      });
      expect(reports.at(-1)).toEqual({ received: 3, total: null });
    });

    it('follows a redirect before it starts counting', async () => {
      script([
        { status: 302, location: 'https://cdn.test/a.zip' },
        { status: 200, body: 'abcd', length: 4 },
      ]);
      const reports: { received: number; total: number | null }[] = [];
      await downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), {
        onProgress: (progress) => reports.push(progress),
      });
      expect(reports.at(-1)).toEqual({ received: 4, total: 4 });
    });

    it('throttles to whole-percent steps when chunks arrive faster than the clock', async () => {
      const chunks = Array.from({ length: 400 }, () => 'x');
      script([{ status: 200, chunks, length: 400 }]);
      const reports: { received: number; total: number | null }[] = [];
      await downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), {
        onProgress: (progress) => reports.push(progress),
        now: () => 0,
      });
      // One report per whole percent (plus the opening zero), never per chunk.
      expect(reports.length).toBeLessThanOrEqual(102);
      expect(reports.at(-1)).toEqual({ received: 400, total: 400 });
    });

    it('reports on the clock alone when the total is unknown', async () => {
      const chunks = ['a', 'b', 'c', 'd'];
      script([{ status: 200, chunks }]);
      let clock = 0;
      const reports: { received: number; total: number | null }[] = [];
      await downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), {
        onProgress: (progress) => {
          reports.push(progress);
        },
        now: () => (clock += 100),
      });
      // 100 ms per chunk: only every third tick crosses the 250 ms step, and
      // the finished byte count always lands.
      expect(reports.length).toBeLessThan(chunks.length + 1);
      expect(reports.at(-1)).toEqual({ received: 4, total: null });
    });
  });
});
