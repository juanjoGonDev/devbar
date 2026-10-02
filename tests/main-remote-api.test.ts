import { describe, expect, it } from 'vitest';
import { createApi, type ApiRequest } from '../src/main/remote/api.js';
import { createDeviceStore } from '../src/main/remote/device-store.js';
import { createPairing } from '../src/main/remote/pairing.js';
import { createRateLimiter } from '../src/main/remote/rate-limit.js';
import type { RemotePairRequest } from '../src/ipc-contract/remote-api.js';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const COOKIE = /^devbar_session=([A-Za-z0-9_-]{43}); HttpOnly/;
const CLEARED = 'devbar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

function harness() {
  let clock = 10_000_000;
  const now = () => clock;
  const events: string[] = [];
  const requests: RemotePairRequest[] = [];
  const devices = createDeviceStore({
    read: () => undefined,
    write: () => undefined,
    now,
  });
  const pairing = createPairing({ now });
  const api = createApi({
    devices,
    pairing,
    limiter: createRateLimiter({ limit: 5, windowMs: 60_000, now }),
    hostInfo: () => ({ name: 'mac-de-ana', version: '0.11.0' }),
    devicesChanged: () => events.push('changed'),
    pairRequested: (request) => {
      events.push('pairRequested');
      requests.push(request);
    },
    pairWithdrawn: (requestId) => events.push(`withdrawn:${requestId}`),
    deviceUnlinked: (id) => events.push(`unlinked:${id}`),
  });
  const call = (request: Partial<ApiRequest>) =>
    api({
      method: 'GET',
      pathname: '/api/me',
      query: new URLSearchParams(),
      token: null,
      ip: '192.168.1.40',
      userAgent: IPHONE_UA,
      body: undefined,
      ...request,
    });
  const requestPairing = (code: string, name = 'iPhone de Ana', ip?: string) =>
    call({
      method: 'POST',
      pathname: '/api/pair/request',
      body: { code, name },
      ...(ip ? { ip } : {}),
    });
  const pollStatus = (id: string) =>
    call({ pathname: '/api/pair/status', query: new URLSearchParams({ id }) });
  /** The whole handshake, accepted: the session token the phone ends with. */
  const link = (): string => {
    const { code } = pairing.startPairing();
    const answer = requestPairing(code).body as { requestId: string };
    pairing.respond(answer.requestId, true);
    const cookie = pollStatus(answer.requestId).setCookie ?? '';
    return COOKIE.exec(cookie)?.[1] ?? '';
  };
  return {
    call,
    devices,
    pairing,
    events,
    requests,
    requestPairing,
    pollStatus,
    link,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('src/main/remote/api.ts', () => {
  describe('GET /api/me', () => {
    it('tells an unknown browser it is not linked, with a name to suggest', () => {
      const h = harness();

      expect(h.call({})).toEqual({
        status: 200,
        body: {
          linked: false,
          host: { name: 'mac-de-ana' },
          suggestedName: 'iPhone',
        },
      });
    });

    it('clears a session cookie that no longer matches a device', () => {
      const h = harness();

      expect(h.call({ token: 'x'.repeat(43) })).toMatchObject({
        status: 200,
        body: { linked: false },
        setCookie: CLEARED,
      });
    });

    it('recognises a linked device and records that it was seen', () => {
      const h = harness();
      const token = h.link();
      h.events.length = 0;
      h.advance(2 * 60_000);

      const response = h.call({ token });

      expect(response).toEqual({
        status: 200,
        body: {
          linked: true,
          device: {
            id: h.devices.list()[0]?.id,
            name: 'iPhone de Ana',
            createdAt: 10_000_000,
          },
          host: { name: 'mac-de-ana', version: '0.11.0' },
        },
      });
      expect(h.events).toEqual(['changed']);
    });
  });

  describe('POST /api/pair/request', () => {
    it('opens a request for a valid code and tells the desktop', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();

      const response = h.requestPairing(code);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        requestId: h.requests[0]?.requestId,
        verificationCode: h.requests[0]?.verificationCode,
        expiresAt: h.requests[0]?.expiresAt,
      });
      expect(h.requests[0]).toMatchObject({
        name: 'iPhone de Ana',
        client: 'Safari · iOS',
        ip: '192.168.1.40',
      });
    });

    it('answers 410 with the reason for a used or unknown code', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      h.requestPairing(code);

      expect(h.requestPairing(code)).toEqual({
        status: 410,
        body: { error: 'used' },
      });
      expect(h.requestPairing('nope')).toEqual({
        status: 410,
        body: { error: 'invalid' },
      });
    });

    it('refuses an invalid name before spending the code', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();

      expect(h.requestPairing(code, '   ')).toEqual({
        status: 400,
        body: { error: 'invalid-name' },
      });
      expect(h.requestPairing(code).status).toBe(200);
    });

    it('refuses a body that is not the expected shape', () => {
      const h = harness();

      expect(
        h.call({ method: 'POST', pathname: '/api/pair/request', body: [1] }),
      ).toEqual({ status: 400, body: { error: 'invalid-request' } });
    });

    it('allows five attempts a minute per address, then answers 429', () => {
      const h = harness();
      const statuses = Array.from(
        { length: 6 },
        () => h.requestPairing('guess').status,
      );

      expect(statuses).toEqual([410, 410, 410, 410, 410, 429]);
      expect(h.requestPairing('guess', 'x', '192.168.1.41').status).toBe(410);
    });
  });

  describe('GET /api/pair/status', () => {
    it('reports pending, then sets the session cookie exactly once on accept', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      const { requestId } = h.requestPairing(code).body as {
        requestId: string;
      };

      expect(h.pollStatus(requestId)).toEqual({
        status: 200,
        body: { status: 'pending' },
      });
      h.pairing.respond(requestId, true);
      const accepted = h.pollStatus(requestId);

      expect(accepted).toMatchObject({
        status: 200,
        body: {
          status: 'accepted',
          device: { name: 'iPhone de Ana' },
        },
      });
      const token = COOKIE.exec(accepted.setCookie ?? '')?.[1] ?? '';
      expect(h.devices.findByToken(token)?.client).toBe('Safari · iOS');
      expect(h.events).toContain('changed');
      // The token is never handed out a second time.
      expect(h.pollStatus(requestId)).toEqual({
        status: 404,
        body: { error: 'unknown-request' },
      });
    });

    it('reports a rejection without creating anything', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      const { requestId } = h.requestPairing(code).body as {
        requestId: string;
      };
      h.pairing.respond(requestId, false);

      expect(h.pollStatus(requestId)).toEqual({
        status: 200,
        body: { status: 'rejected' },
      });
      expect(h.devices.list()).toEqual([]);
    });

    it('answers 400 without an id', () => {
      const h = harness();

      expect(h.call({ pathname: '/api/pair/status' })).toEqual({
        status: 400,
        body: { error: 'invalid-request' },
      });
    });
  });

  describe('POST /api/pair/cancel', () => {
    const cancel = (h: ReturnType<typeof harness>, body: unknown) =>
      h.call({ method: 'POST', pathname: '/api/pair/cancel', body });

    it('withdraws the pending request so the desktop can close its dialog', () => {
      const h = harness();
      const { code } = h.pairing.startPairing();
      const { requestId } = h.requestPairing(code).body as {
        requestId: string;
      };

      expect(cancel(h, { requestId })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(h.events).toContain(`withdrawn:${requestId}`);
      expect(h.pollStatus(requestId).status).toBe(404);
    });

    it('answers 404 for a request that is no longer pending', () => {
      const h = harness();

      expect(cancel(h, { requestId: 'ghost' })).toEqual({
        status: 404,
        body: { error: 'unknown-request' },
      });
    });

    it('answers 400 to a body without a request id', () => {
      const h = harness();

      expect(cancel(h, { requestId: 7 }).status).toBe(400);
    });
  });

  describe('POST /api/unlink', () => {
    it('removes the calling device and clears its cookie', () => {
      const h = harness();
      const token = h.link();
      const id = h.devices.list()[0]?.id;

      expect(
        h.call({ method: 'POST', pathname: '/api/unlink', token, body: {} }),
      ).toEqual({ status: 200, body: { ok: true }, setCookie: CLEARED });
      expect(h.events).toContain(`unlinked:${id}`);
      expect(h.devices.list()).toEqual([]);
      expect(h.call({ token }).body).toMatchObject({ linked: false });
    });

    it('answers 401 to a caller that is not linked', () => {
      const h = harness();

      expect(
        h.call({ method: 'POST', pathname: '/api/unlink', body: {} }),
      ).toEqual({
        status: 401,
        body: { error: 'unlinked' },
        setCookie: CLEARED,
      });
    });
  });

  describe('routing', () => {
    it('answers 404 to an unknown endpoint and 405 to a wrong method', () => {
      const h = harness();

      expect(h.call({ pathname: '/api/nope' })).toEqual({
        status: 404,
        body: { error: 'not-found' },
      });
      expect(h.call({ method: 'POST', pathname: '/api/me' })).toEqual({
        status: 405,
        body: { error: 'method-not-allowed' },
      });
    });
  });
});
