import type { RemotePairRequest } from '../../ipc-contract/remote-api.js';
import type { DeviceStore } from './device-store.js';
import { normalizeDeviceName } from './device-store.js';
import { clearedSessionCookie, sessionCookie } from './http-guard.js';
import type { Pairing } from './pairing.js';
import type { RateLimiter } from './rate-limit.js';
import { clientLabel, suggestedDeviceName } from './user-agent.js';
import { idField, record } from './validate.js';

/**
 * The JSON endpoints of the remote-control server, as a pure function of an
 * already-vetted request (host, method shape and body size were checked by
 * the server before this runs). Answers are plain data, so every rule here —
 * who is linked, when the token is handed out, what a refusal says — is
 * testable without a socket.
 */

export interface ApiRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  /** The well-formed session token from the cookie, if any. */
  token: string | null;
  ip: string;
  userAgent: string | undefined;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  setCookie?: string;
}

export interface ApiDeps {
  devices: Pick<DeviceStore, 'add' | 'findByToken' | 'remove' | 'touch'>;
  pairing: Pick<Pairing, 'request' | 'status' | 'takeAccepted' | 'withdraw'>;
  limiter: RateLimiter;
  hostInfo(): { name: string; version: string };
  devicesChanged(): void;
  pairRequested(request: RemotePairRequest): void;
  /** The phone cancelled a pending request: the desktop closes its dialog. */
  pairWithdrawn(requestId: string): void;
  /** A device unlinked itself: its live streams have to go too. */
  deviceUnlinked(deviceId: string): void;
}

type Handler = (request: ApiRequest) => ApiResponse;

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});
const invalidRequest = (): ApiResponse =>
  json(400, { error: 'invalid-request' });

export function createApi(deps: ApiDeps): Handler {
  const { devices, pairing } = deps;

  const caller = (request: ApiRequest) =>
    request.token ? devices.findByToken(request.token) : null;

  const me: Handler = (request) => {
    const device = caller(request);
    const host = deps.hostInfo();
    if (device) {
      if (devices.touch(device.id)) deps.devicesChanged();
      return json(200, {
        linked: true,
        device: {
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
        },
        host,
      });
    }
    // An unlinked visitor learns the name it is about to pair with, not
    // which DevBar version runs here.
    const response = json(200, {
      linked: false,
      host: { name: host.name },
      suggestedName: suggestedDeviceName(request.userAgent),
    });
    return request.token
      ? { ...response, setCookie: clearedSessionCookie() }
      : response;
  };

  const pairRequest: Handler = (request) => {
    if (!deps.limiter.allow(request.ip))
      return json(429, { error: 'rate-limited' });
    const body = record(request.body);
    if (!body || typeof body.code !== 'string') return invalidRequest();
    const name = normalizeDeviceName(body.name);
    if (name === null) return json(400, { error: 'invalid-name' });
    const result = pairing.request({
      code: body.code,
      name,
      client: clientLabel(request.userAgent),
      ip: request.ip,
    });
    if (!result.ok) return json(410, { error: result.reason });
    deps.pairRequested(result.request);
    const { requestId, verificationCode, expiresAt } = result.request;
    return json(200, { requestId, verificationCode, expiresAt });
  };

  const pairStatus: Handler = (request) => {
    const id = request.query.get('id');
    if (!id) return invalidRequest();
    const status = pairing.status(id);
    if (status === null) return json(404, { error: 'unknown-request' });
    if (status !== 'accepted') return json(200, { status });
    const accepted = pairing.takeAccepted(id);
    if (!accepted) return json(404, { error: 'unknown-request' });
    // First accepted read: the device is born here, and its token travels
    // only in this response's cookie — it is never readable again.
    const { device, token } = devices.add({
      name: accepted.name,
      client: accepted.client,
    });
    deps.devicesChanged();
    return {
      ...json(200, {
        status: 'accepted',
        device: { id: device.id, name: device.name },
      }),
      setCookie: sessionCookie(token),
    };
  };

  const pairCancel: Handler = (request) => {
    const requestId = idField(request.body, 'requestId');
    if (!requestId) return invalidRequest();
    if (!pairing.withdraw(requestId))
      return json(404, { error: 'unknown-request' });
    deps.pairWithdrawn(requestId);
    return json(200, { ok: true });
  };

  const unlink: Handler = (request) => {
    const device = caller(request);
    if (!device)
      return {
        ...json(401, { error: 'unlinked' }),
        setCookie: clearedSessionCookie(),
      };
    devices.remove(device.id);
    deps.deviceUnlinked(device.id);
    deps.devicesChanged();
    return { ...json(200, { ok: true }), setCookie: clearedSessionCookie() };
  };

  const routes = new Map<string, { method: string; handler: Handler }>([
    ['/api/me', { method: 'GET', handler: me }],
    ['/api/pair/request', { method: 'POST', handler: pairRequest }],
    ['/api/pair/status', { method: 'GET', handler: pairStatus }],
    ['/api/pair/cancel', { method: 'POST', handler: pairCancel }],
    ['/api/unlink', { method: 'POST', handler: unlink }],
  ]);

  return (request) => {
    const route = routes.get(request.pathname);
    if (!route) return json(404, { error: 'not-found' });
    if (route.method !== request.method)
      return json(405, { error: 'method-not-allowed' });
    return route.handler(request);
  };
}
