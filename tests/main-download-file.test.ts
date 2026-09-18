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
    res.headers = spec.location ? { location: spec.location } : {};
    setImmediate(() => {
      cb(res);
      if (spec.failMidBody) {
        res.destroy(new Error('ECONNRESET'));
        return;
      }
      if (spec.status === 200) res.push(spec.body ?? 'payload');
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
        downloadFile('https://github.test/a.zip', path.join(dir, 'a.zip'), 2),
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
});
