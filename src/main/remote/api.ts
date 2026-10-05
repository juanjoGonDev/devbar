import type {
  RemoteDeviceView,
  RemotePairRequest,
} from '../../ipc-contract/remote-api.js';
import type { DeviceStore } from './device-store.js';
import { normalizeDeviceName } from './device-store.js';
import type { Pairing } from './pairing.js';
import type { RateLimiter } from './rate-limit.js';
import {
  authMessage,
  fromB64,
  KEY_BYTES,
  SIGNATURE_BYTES,
  verifySignature,
} from './rc-protocol.js';
import type { Session } from './sessions.js';
import { clientLabel, suggestedDeviceName } from './user-agent.js';
import { idField, record } from './validate.js';

/**
 * The session-level operations of devbar-rc/1, as plain functions of an
 * already-decrypted call (src/main/remote/secure-api.ts opened it):
 *
 *   me            who this is talking to — the host name for anyone, the
 *                 device and the DevBar version once the session proved it;
 *   pair.*        the pairing handshake, open to an unauthenticated session;
 *   auth          the device signs "devbar-rc/1 auth" ‖ T of THIS handshake
 *                 with its key, and the session becomes that device's;
 *   unlink, verify.done, device.rotate
 *                 what only a proven device may do to itself.
 *
 * Answers are plain data, so every rule is testable without a socket.
 */

export interface ApiRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  /** The well-formed `X-DevBar-Session` header, if any. */
  sessionId: string | null;
  ip: string;
  userAgent: string | undefined;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** One decrypted call: the session it came over, and from where. */
export interface RpcCall {
  session: Session;
  ip: string;
  userAgent: string | undefined;
}

export interface SessionApiDeps {
  devices: Pick<
    DeviceStore,
    | 'add'
    | 'find'
    | 'devicePub'
    | 'setDevicePub'
    | 'markVerified'
    | 'remove'
    | 'touch'
  >;
  pairing: Pick<Pairing, 'request' | 'status' | 'takeAccepted' | 'withdraw'>;
  limiter: RateLimiter;
  hostInfo(): { name: string; version: string };
  devicesChanged(): void;
  pairRequested(request: RemotePairRequest): void;
  /** The phone cancelled a pending request: the desktop closes its dialog. */
  pairWithdrawn(requestId: string): void;
  /** A device unlinked itself: its sessions and live streams have to go. */
  deviceUnlinked(deviceId: string): void;
  /** A device replaced its key: every session it had is dropped. */
  deviceRotated(deviceId: string): void;
  /** A session just proved to be this device, connecting from `ip`. */
  deviceAuthenticated(deviceId: string, ip: string): void;
}

export interface SessionApi {
  handles(op: string): boolean;
  handle(op: string, args: unknown, call: RpcCall): ApiResponse;
}

type Handler = (args: unknown, call: RpcCall) => ApiResponse;
type DeviceHandler = (
  args: unknown,
  call: RpcCall,
  device: RemoteDeviceView,
) => ApiResponse;

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});
const invalidRequest = (): ApiResponse =>
  json(400, { error: 'invalid-request' });
const unlinked = (): ApiResponse => json(401, { error: 'unlinked' });
const ok = (): ApiResponse => json(200, { ok: true });

export function createSessionApi(deps: SessionApiDeps): SessionApi {
  const { devices, pairing } = deps;

  /** The device this session proved to be, if it still exists. */
  const deviceOf = (call: RpcCall): RemoteDeviceView | null =>
    call.session.deviceId ? devices.find(call.session.deviceId) : null;
  const asDevice =
    (handler: DeviceHandler): Handler =>
    (args, call) => {
      const device = deviceOf(call);
      return device ? handler(args, call, device) : unlinked();
    };

  const me: Handler = (_args, call) => {
    const host = deps.hostInfo();
    const device = deviceOf(call);
    if (device)
      return json(200, {
        linked: true,
        device: {
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
        },
        host,
      });
    // An unauthenticated session learns the name it is about to pair with,
    // not which DevBar version runs here.
    return json(200, {
      linked: false,
      host: { name: host.name },
      suggestedName: suggestedDeviceName(call.userAgent),
    });
  };

  const pairRequest: Handler = (args, call) => {
    if (!deps.limiter.allow(call.ip))
      return json(429, { error: 'rate-limited' });
    const body = record(args);
    if (!body || typeof body.code !== 'string') return invalidRequest();
    const name = normalizeDeviceName(body.name);
    if (name === null) return json(400, { error: 'invalid-name' });
    const devicePub = fromB64(body.devicePub, KEY_BYTES);
    if (!devicePub) return invalidRequest();
    const result = pairing.request({
      code: body.code,
      name,
      client: clientLabel(call.userAgent),
      ip: call.ip,
      devicePub: body.devicePub as string,
    });
    if (!result.ok) return json(410, { error: result.reason });
    deps.pairRequested(result.request);
    const { requestId, verificationCode, expiresAt } = result.request;
    return json(200, { requestId, verificationCode, expiresAt });
  };

  const pairStatus: Handler = (args) => {
    const requestId = idField(args, 'requestId');
    if (!requestId) return invalidRequest();
    const status = pairing.status(requestId);
    if (status === null) return json(404, { error: 'unknown-request' });
    if (status !== 'accepted') return json(200, { status });
    const accepted = pairing.takeAccepted(requestId);
    if (!accepted) return json(404, { error: 'unknown-request' });
    // First accepted read: the device is born here, known from now on by
    // the key it sent with its request.
    const device = devices.add({
      name: accepted.name,
      client: accepted.client,
      devicePub: accepted.devicePub,
    });
    deps.devicesChanged();
    return json(200, { status: 'accepted', deviceId: device.id });
  };

  const pairCancel: Handler = (args) => {
    const requestId = idField(args, 'requestId');
    if (!requestId) return invalidRequest();
    if (!pairing.withdraw(requestId))
      return json(404, { error: 'unknown-request' });
    deps.pairWithdrawn(requestId);
    return ok();
  };

  const auth: Handler = (args, call) => {
    const deviceId = idField(args, 'deviceId');
    const stored = deviceId ? devices.devicePub(deviceId) : null;
    const key = fromB64(stored, KEY_BYTES);
    const signature = fromB64(record(args)?.sig, SIGNATURE_BYTES);
    // One answer for every failure: an unknown device, another key and a
    // proof for another handshake all read the same from outside.
    if (
      !deviceId ||
      !key ||
      !signature ||
      !verifySignature(key, authMessage(call.session.transcript), signature)
    )
      return unlinked();
    call.session.deviceId = deviceId;
    if (devices.touch(deviceId)) deps.devicesChanged();
    deps.deviceAuthenticated(deviceId, call.ip);
    return ok();
  };

  const unlink: DeviceHandler = (_args, _call, device) => {
    devices.remove(device.id);
    deps.deviceUnlinked(device.id);
    deps.devicesChanged();
    return ok();
  };

  const verifyDone: DeviceHandler = (_args, _call, device) => {
    devices.markVerified(device.id);
    deps.devicesChanged();
    return ok();
  };

  const rotate: DeviceHandler = (args, _call, device) => {
    const devicePub = record(args)?.devicePub;
    if (!fromB64(devicePub, KEY_BYTES)) return invalidRequest();
    devices.setDevicePub(device.id, devicePub as string);
    deps.deviceRotated(device.id);
    deps.devicesChanged();
    return ok();
  };

  const ops = new Map<string, Handler>([
    ['me', me],
    ['pair.request', pairRequest],
    ['pair.status', pairStatus],
    ['pair.cancel', pairCancel],
    ['auth', auth],
    ['unlink', asDevice(unlink)],
    ['verify.done', asDevice(verifyDone)],
    ['device.rotate', asDevice(rotate)],
  ]);

  return {
    handles: (op) => ops.has(op),
    handle: (op, args, call) =>
      ops.get(op)?.(args, call) ?? json(404, { error: 'unknown-op' }),
  };
}
