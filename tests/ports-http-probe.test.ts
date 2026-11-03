import { describe, expect, it, vi } from 'vitest';
import {
  classifyResponse,
  createPortClassifier,
  probePort,
  type HttpGet,
  type PortKind,
  type ProbeResponse,
} from '../src/ports/http-probe.js';

function answers(map: Record<string, ProbeResponse | null>): HttpGet & {
  mock: { calls: unknown[][] };
} {
  return vi.fn((url: string) => Promise.resolve(map[url] ?? null));
}

const html = (status = 200): ProbeResponse => ({
  status,
  contentType: 'text/html; charset=utf-8',
  location: null,
});

describe('src/ports/http-probe.ts', () => {
  describe('classifyResponse', () => {
    it.each<[string, ProbeResponse | null, PortKind]>([
      ['an HTML page', html(), 'web'],
      ['an HTML 404 (an SPA dev server without /)', html(404), 'web'],
      ['an HTML 401 login wall', html(401), 'web'],
      [
        'a JSON API',
        { status: 200, contentType: 'application/json', location: null },
        'http',
      ],
      [
        'an API 404 without a body type',
        { status: 404, contentType: null, location: null },
        'http',
      ],
      [
        'a redirect it could not follow',
        { status: 302, contentType: null, location: 'https://sso.example.com' },
        'web',
      ],
      ['nothing HTTP (Postgres, Redis, a timeout)', null, 'other'],
    ])('%s', (_name, response, kind) => {
      expect(classifyResponse(response)).toBe(kind);
    });
  });

  describe('probePort', () => {
    it('follows local redirects up to the page', async () => {
      const get = answers({
        'http://localhost:3000/': {
          status: 302,
          contentType: 'text/plain',
          location: '/login',
        },
        'http://localhost:3000/login': html(),
      });
      expect(await probePort('http://localhost:3000/', get)).toBe('web');
      expect(get.mock.calls.map((call) => call[0])).toEqual([
        'http://localhost:3000/',
        'http://localhost:3000/login',
      ]);
    });

    it('never follows a redirect off this machine', async () => {
      const get = answers({
        'http://localhost:3000/': {
          status: 302,
          contentType: null,
          location: 'https://accounts.example.com/',
        },
      });
      expect(await probePort('http://localhost:3000/', get)).toBe('web');
      expect(get.mock.calls).toHaveLength(1);
    });

    it('stops after three redirects', async () => {
      const loop: ProbeResponse = {
        status: 301,
        contentType: null,
        location: '/again',
      };
      const get = vi.fn(() => Promise.resolve(loop));
      await probePort('http://localhost:3000/', get);
      expect(get).toHaveBeenCalledTimes(4);
    });

    it('passes the 800 ms budget to each request', async () => {
      const get = vi.fn(() => Promise.resolve(null));
      expect(await probePort('http://localhost:5432/', get)).toBe('other');
      expect(get).toHaveBeenCalledWith('http://localhost:5432/', 800);
    });
  });

  describe('createPortClassifier', () => {
    it('probes a port once per process run, however often it is asked', async () => {
      const probe = vi.fn(() => Promise.resolve<PortKind>('web'));
      const classifier = createPortClassifier(probe);
      const [a, b] = await Promise.all([
        classifier.kind('cmd:g:a', 3000, 'http://localhost:3000/'),
        classifier.kind('cmd:g:a', 3000, 'http://localhost:3000/'),
      ]);
      expect([a, b]).toEqual(['web', 'web']);
      expect(probe).toHaveBeenCalledOnce();
      expect(classifier.known('cmd:g:a', 3000)).toBe('web');
    });

    it('probes again after the process restarts', async () => {
      const probe = vi
        .fn<(url: string) => Promise<PortKind>>()
        .mockResolvedValueOnce('http')
        .mockResolvedValueOnce('web');
      const classifier = createPortClassifier(probe);
      await classifier.kind('cmd:g:a', 3000, 'http://localhost:3000/');
      classifier.forget('cmd:g:a');
      expect(classifier.known('cmd:g:a', 3000)).toBeNull();
      expect(
        await classifier.kind('cmd:g:a', 3000, 'http://localhost:3000/'),
      ).toBe('web');
    });

    it('does not record a verdict that lands after the process was forgotten', async () => {
      let release: (kind: PortKind) => void = () => {};
      const classifier = createPortClassifier(
        () => new Promise((resolve) => (release = resolve)),
      );
      const verdict = classifier.kind(
        'cmd:g:a',
        3000,
        'http://localhost:3000/',
      );
      classifier.forget('cmd:g:a');
      release('web');
      await verdict;
      expect(classifier.known('cmd:g:a', 3000)).toBeNull();
    });

    it('reads a probe that throws as not HTTP', async () => {
      const classifier = createPortClassifier(() =>
        Promise.reject(new Error('boom')),
      );
      expect(await classifier.kind('cmd:g:a', 1, 'http://localhost:1/')).toBe(
        'other',
      );
    });
  });
});
