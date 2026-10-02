import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../src/main/remote/api.js';
import {
  createRemoteServer,
  type RemoteServer,
  type RemoteServerDeps,
} from '../src/main/remote/server.js';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: RemoteServer[] = [];

function harness(overrides: Partial<RemoteServerDeps> = {}) {
  const apiCalls: ApiRequest[] = [];
  let stateChanges = 0;
  let apiAnswer: ApiResponse = { status: 200, body: { ok: true } };
  const server = createRemoteServer({
    port: 0,
    listenHost: '127.0.0.1',
    addresses: () => ['192.168.1.20'],
    readStatic: (file) =>
      file === 'remote.html'
        ? Buffer.from('<!doctype html><title>remote</title>')
        : file === 'remote.css'
          ? Buffer.from('body{}')
          : null,
    api: (request) => {
      apiCalls.push(request);
      return apiAnswer;
    },
    onStateChange: () => {
      stateChanges += 1;
    },
    ...overrides,
  });
  servers.push(server);

  const send = (
    options: {
      method?: string;
      path?: string;
      host?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
    } = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const port = server.port();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: options.method ?? 'GET',
          path: options.path ?? '/',
          headers: {
            host: options.host ?? `127.0.0.1:${port}`,
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    send({
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'x-devbar-request': '1',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  return {
    server,
    send,
    post,
    apiCalls,
    stateChanges: () => stateChanges,
    answer: (response: ApiResponse) => {
      apiAnswer = response;
    },
  };
}

describe('src/main/remote/server.ts', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  describe('lifecycle', () => {
    it('listens on start and stops answering on stop', async () => {
      const h = harness();

      await h.server.start();
      expect(h.server.listening()).toBe(true);
      expect(h.server.port()).toBeGreaterThan(0);
      expect((await h.send()).status).toBe(200);

      const port = h.server.port();
      await h.server.stop();
      expect(h.server.listening()).toBe(false);
      await expect(
        new Promise((resolve, reject) =>
          http.get({ host: '127.0.0.1', port }, resolve).on('error', reject),
        ),
      ).rejects.toThrow();
      expect(h.stateChanges()).toBe(2);
    });

    it('reports a port already in use instead of throwing', async () => {
      const first = harness();
      await first.server.start();
      const second = harness({ port: first.server.port() });

      await second.server.start();

      expect(second.server.listening()).toBe(false);
      expect(second.server.error()).toBe(
        `El puerto ${first.server.port()} ya está en uso por otra aplicación.`,
      );
      expect(second.stateChanges()).toBe(1);
    });

    it('survives server errors after it is listening', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const created: http.Server[] = [];
      const h = harness({
        createHttpServer: (listener) => {
          const inner = http.createServer(listener);
          created.push(inner);
          return inner;
        },
      });
      await h.server.start();

      created[0]?.emit('error', new Error('EMFILE'));
      created[0]?.emit('error', new Error('EMFILE'));

      expect(h.server.listening()).toBe(true);
      expect(h.server.error()).toBeNull();
      expect(logged).toHaveBeenCalledTimes(2);
      logged.mockRestore();
    });

    it('is idempotent on start and on stop', async () => {
      const h = harness();
      await h.server.start();
      const port = h.server.port();
      await h.server.start();

      expect(h.server.port()).toBe(port);
      await h.server.stop();
      await h.server.stop();
      expect(h.server.listening()).toBe(false);
    });
  });

  describe('every response', () => {
    it('carries the hardening headers', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.send({ path: '/nope' });

      expect(reply.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      });
    });
  });

  describe('Host check (DNS rebinding)', () => {
    it('answers 421 to a name that is not one of ours', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.send({ host: `evil.example:${h.server.port()}` });

      expect(reply.status).toBe(421);
      expect(h.apiCalls).toEqual([]);
    });

    it('answers a LAN address of this machine', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.send({ host: `192.168.1.20:${h.server.port()}` });

      expect(reply.status).toBe(200);
    });
  });

  describe('static files', () => {
    it('serves the page shell with its CSP for / and /pair', async () => {
      const h = harness();
      await h.server.start();

      for (const path of ['/', '/pair?c=abc']) {
        const reply = await h.send({ path });
        expect(reply.status).toBe(200);
        expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(reply.headers['content-security-policy']).toBe(
          "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        );
        expect(reply.body).toContain('<title>remote</title>');
      }
    });

    it('serves a whitelisted stylesheet with its type', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.send({ path: '/remote.css' });

      expect(reply.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(reply.headers['content-security-policy']).toBeUndefined();
      expect(reply.body).toBe('body{}');
    });

    it('answers 404 outside the whitelist and for a missing build file', async () => {
      const h = harness();
      await h.server.start();

      expect((await h.send({ path: '/config.html' })).status).toBe(404);
      expect((await h.send({ path: '/remote/../config.js' })).status).toBe(404);
      expect((await h.send({ path: '/remote.js' })).status).toBe(404);
    });
  });

  describe('methods', () => {
    it('never answers a CORS preflight', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.send({
        method: 'OPTIONS',
        path: '/api/unlink',
        headers: {
          origin: 'http://evil.example',
          'access-control-request-method': 'POST',
        },
      });

      expect(reply.status).toBe(405);
      expect(
        Object.keys(reply.headers).filter((name) =>
          name.startsWith('access-control-'),
        ),
      ).toEqual([]);
    });

    it('refuses a POST to a page', async () => {
      const h = harness();
      await h.server.start();

      expect((await h.post('/', {})).status).toBe(405);
    });
  });

  describe('API requests', () => {
    it('hands the vetted request to the API and relays its answer', async () => {
      const h = harness();
      await h.server.start();
      h.answer({ status: 201, body: { hi: 1 }, setCookie: 'devbar_session=x' });

      const token = 'T'.repeat(43);
      const reply = await h.post(
        '/api/pair/request',
        { code: 'c', name: 'n' },
        {
          cookie: `devbar_session=${token}`,
          'user-agent': 'TestAgent/1',
          origin: `http://127.0.0.1:${h.server.port()}`,
        },
      );

      expect(reply.status).toBe(201);
      expect(JSON.parse(reply.body)).toEqual({ hi: 1 });
      expect(reply.headers['set-cookie']).toEqual(['devbar_session=x']);
      expect(reply.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      );
      expect(h.apiCalls[0]).toMatchObject({
        method: 'POST',
        pathname: '/api/pair/request',
        token,
        ip: '127.0.0.1',
        userAgent: 'TestAgent/1',
        body: { code: 'c', name: 'n' },
      });
    });

    it('passes the query string of a GET through', async () => {
      const h = harness();
      await h.server.start();

      await h.send({ path: '/api/pair/status?id=abc' });

      expect(h.apiCalls[0]?.query.get('id')).toBe('abc');
      expect(h.apiCalls[0]?.body).toBeUndefined();
    });

    it('answers 403 to a mutation without the DevBar shape', async () => {
      const h = harness();
      await h.server.start();

      const replies = [
        await h.post('/api/unlink', {}, { 'content-type': 'text/plain' }),
        await h.post('/api/unlink', {}, { 'x-devbar-request': '' }),
        await h.post('/api/unlink', {}, { origin: 'http://evil.example' }),
      ];

      expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403]);
      expect(h.apiCalls).toEqual([]);
    });

    it('answers 413 to a body over 16 KB', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.post('/api/pair/request', {
        name: 'x'.repeat(17 * 1024),
      });

      expect(reply.status).toBe(413);
      expect(h.apiCalls).toEqual([]);
    });

    it('answers 400 to a body that is not JSON', async () => {
      const h = harness();
      await h.server.start();

      const reply = await h.send({
        method: 'POST',
        path: '/api/unlink',
        headers: {
          'content-type': 'application/json',
          'x-devbar-request': '1',
        },
        body: '{oops',
      });

      expect(reply.status).toBe(400);
    });

    it('answers 500 without details when the API throws', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness({
        api: () => {
          throw new Error('secret internals');
        },
      });
      await h.server.start();

      const reply = await h.send({ path: '/api/me' });

      expect(reply.status).toBe(500);
      expect(reply.body).not.toContain('secret');
      expect(logged).toHaveBeenCalledOnce();
      logged.mockRestore();
    });
  });

  describe('asynchronous answers', () => {
    it('waits for an API answer that is a promise', async () => {
      const h = harness({
        api: () => Promise.resolve({ status: 202, body: { pending: true } }),
      });
      await h.server.start();

      const reply = await h.send({ path: '/api/state' });

      expect(reply.status).toBe(202);
      expect(JSON.parse(reply.body)).toEqual({ pending: true });
    });
  });

  describe('GET /api/events', () => {
    /** Opens the stream and resolves with its response once data arrives. */
    function openStream(
      port: number,
      path = '/api/events',
    ): Promise<{ res: http.IncomingMessage; first: string; abort(): void }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path,
            headers: { host: `127.0.0.1:${port}` },
          },
          (res) => {
            res.once('data', (chunk: Buffer) =>
              resolve({
                res,
                first: chunk.toString('utf8'),
                abort: () => req.destroy(),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    it('streams events with the SSE content type until the client leaves', async () => {
      let detached = 0;
      const seen: ApiRequest[] = [];
      const h = harness({
        stream: (request) => {
          seen.push(request);
          return {
            open: (sink) => {
              sink.write('event: state\ndata: {}\n\n');
              return () => {
                detached += 1;
              };
            },
          };
        },
      });
      await h.server.start();

      const stream = await openStream(h.server.port(), '/api/events?logs=x');

      expect(stream.res.statusCode).toBe(200);
      expect(stream.res.headers['content-type']).toBe(
        'text/event-stream; charset=utf-8',
      );
      expect(stream.res.headers['cache-control']).toBe('no-store');
      expect(stream.first).toContain('event: state');
      expect(seen[0]).toMatchObject({ pathname: '/api/events' });
      expect(seen[0]?.query.get('logs')).toBe('x');
      stream.abort();
      await vi.waitFor(() => expect(detached).toBe(1));
    });

    it('answers a refused stream with its JSON status', async () => {
      const h = harness({
        stream: () => ({ status: 401, body: { error: 'unlinked' } }),
      });
      await h.server.start();

      const reply = await h.send({ path: '/api/events' });

      expect(reply.status).toBe(401);
      expect(JSON.parse(reply.body)).toEqual({ error: 'unlinked' });
    });

    it('lets the hub end a stream', async () => {
      const h = harness({
        stream: () => ({
          open: (sink) => {
            sink.write(': hello\n\n');
            sink.end();
            return () => undefined;
          },
        }),
      });
      await h.server.start();

      const reply = await h.send({ path: '/api/events' });

      expect(reply.body).toBe(': hello\n\n');
    });

    it('cuts a client whose buffer stops draining', async () => {
      let accepted: boolean | null = null;
      const h = harness({
        stream: () => ({
          open: (sink) => {
            accepted = sink.write('x'.repeat(8 * 1024 * 1024));
            return () => undefined;
          },
        }),
      });
      await h.server.start();

      await h.send({ path: '/api/events' }).catch(() => undefined);

      expect(accepted).toBe(false);
    });

    it('closes open streams when it stops', async () => {
      let detached = 0;
      const h = harness({
        stream: () => ({
          open: (sink) => {
            sink.write(': open\n\n');
            return () => {
              detached += 1;
            };
          },
        }),
      });
      await h.server.start();
      const stream = await openStream(h.server.port());
      const ended = new Promise((resolve) => stream.res.on('close', resolve));

      await h.server.stop();

      await ended;
      expect(detached).toBe(1);
    });

    it('sends a POST to the events path to the API, like any other route', async () => {
      const h = harness({
        stream: () => ({ status: 401, body: {} }),
      });
      await h.server.start();

      await h.post('/api/events', {});

      expect(h.apiCalls[0]?.pathname).toBe('/api/events');
    });
  });
});
