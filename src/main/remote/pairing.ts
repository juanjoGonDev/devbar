import crypto from 'node:crypto';
import type { RemotePairRequest } from '../../ipc-contract/remote-api.js';

/**
 * The pairing handshake, as a pure state machine (clock and randomness are
 * injected):
 *
 *   1. The desktop issues THE pairing code — one at a time, single use,
 *      5 minutes. It travels in the QR, so it proves the phone saw this
 *      screen.
 *   2. The phone redeems it for a request: a 60 s window and a 6-digit
 *      verification number both screens show. Seeing the code is not enough —
 *      someone on the desk must accept, and the matching digits tell them
 *      they are accepting THEIR phone and not a neighbour who photographed
 *      the screen first.
 *   3. The phone polls the request; the server hands an accepted one over
 *      exactly once (`takeAccepted`), which is when the device is created
 *      with the public key the phone sent along (devbar-rc/1: the phone
 *      proves it holds the matching private key on every connection).
 *
 * Nothing here is persisted: a restart drops every code and request.
 */

const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 60_000;
/** How long a settled request stays readable for the phone's next poll. */
const SETTLED_RETENTION_MS = 60_000;
/** Recently retired codes, remembered only to explain a refusal. */
const RETIRED_MEMORY = 8;

type PairRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';
type PairCodeRefusal = 'invalid' | 'expired' | 'used';

export interface PairingDeps {
  now(): number;
  randomBytes?: (size: number) => Buffer;
  /** Uniform integer in [min, max). */
  randomInt?: (min: number, max: number) => number;
}

export interface Pairing {
  startPairing(): { code: string; expiresAt: number };
  cancelPairing(): void;
  hasActiveCode(): boolean;
  request(input: {
    code: string;
    name: string;
    client: string;
    ip: string;
    /** The phone's Ed25519 public key, base64url. */
    devicePub: string;
  }):
    | { ok: true; request: RemotePairRequest }
    | { ok: false; reason: PairCodeRefusal };
  /** Null once the request is unknown, handed over or forgotten. */
  status(requestId: string): PairRequestStatus | null;
  /** False when the request is not pending (answered, expired, unknown). */
  respond(requestId: string, accept: boolean): boolean;
  takeAccepted(requestId: string): AcceptedRequest | null;
  /** The phone gave up on a pending request; true when it was pending. */
  withdraw(requestId: string): boolean;
  /** Expires a pending request that is due; true when it just expired. */
  expire(requestId: string): boolean;
  /** Drops the code and every request; the ids that were still pending. */
  clear(): string[];
}

/** An accepted request, with the key the new device will be known by. */
type AcceptedRequest = RemotePairRequest & { devicePub: string };

interface Entry {
  request: RemotePairRequest;
  devicePub: string;
  status: PairRequestStatus;
  settledAt: number | null;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createPairing(deps: PairingDeps): Pairing {
  const randomBytes = deps.randomBytes ?? ((size) => crypto.randomBytes(size));
  const randomInt =
    deps.randomInt ?? ((min, max) => crypto.randomInt(min, max));
  let active: { code: string; expiresAt: number } | null = null;
  const retired: { code: string; reason: 'expired' | 'used' }[] = [];
  const entries = new Map<string, Entry>();

  const retire = (code: string, reason: 'expired' | 'used'): void => {
    retired.unshift({ code, reason });
    retired.length = Math.min(retired.length, RETIRED_MEMORY);
  };

  /** Applies the clock: pending → expired, settled → forgotten. */
  const settle = (id: string): Entry | null => {
    const entry = entries.get(id);
    if (!entry) return null;
    const now = deps.now();
    if (entry.status === 'pending' && now >= entry.request.expiresAt) {
      entry.status = 'expired';
      entry.settledAt = entry.request.expiresAt;
    }
    if (
      entry.settledAt !== null &&
      now - entry.settledAt >= SETTLED_RETENTION_MS
    ) {
      entries.delete(id);
      return null;
    }
    return entry;
  };

  const refusal = (code: string): PairCodeRefusal => {
    if (active && sameSecret(active.code, code)) return 'expired';
    return (
      retired.find((old) => sameSecret(old.code, code))?.reason ?? 'invalid'
    );
  };

  return {
    startPairing: () => {
      if (active) retire(active.code, 'expired');
      active = {
        code: randomBytes(18).toString('base64url'),
        expiresAt: deps.now() + CODE_TTL_MS,
      };
      return { ...active };
    },
    cancelPairing: () => {
      if (active) retire(active.code, 'expired');
      active = null;
    },
    hasActiveCode: () => active !== null && deps.now() < active.expiresAt,
    request: ({ code, name, client, ip, devicePub }) => {
      const now = deps.now();
      if (!active || !sameSecret(active.code, code) || now >= active.expiresAt)
        return { ok: false, reason: refusal(code) };
      retire(active.code, 'used');
      active = null;
      const request: RemotePairRequest = {
        requestId: randomBytes(16).toString('base64url'),
        verificationCode: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        name,
        client,
        ip,
        expiresAt: now + REQUEST_TTL_MS,
      };
      entries.set(request.requestId, {
        request,
        devicePub,
        status: 'pending',
        settledAt: null,
      });
      return { ok: true, request: { ...request } };
    },
    status: (requestId) => settle(requestId)?.status ?? null,
    respond: (requestId, accept) => {
      const entry = settle(requestId);
      if (entry?.status !== 'pending') return false;
      entry.status = accept ? 'accepted' : 'rejected';
      entry.settledAt = deps.now();
      return true;
    },
    takeAccepted: (requestId) => {
      const entry = settle(requestId);
      if (entry?.status !== 'accepted') return null;
      entries.delete(requestId);
      return { ...entry.request, devicePub: entry.devicePub };
    },
    withdraw: (requestId) => {
      if (settle(requestId)?.status !== 'pending') return false;
      return entries.delete(requestId);
    },
    expire: (requestId) => {
      const entry = entries.get(requestId);
      if (entry?.status !== 'pending') return false;
      return settle(requestId)?.status === 'expired';
    },
    clear: () => {
      if (active) retire(active.code, 'expired');
      active = null;
      const pending = [...entries.values()]
        .filter((entry) => entry.status === 'pending')
        .map((entry) => entry.request.requestId);
      entries.clear();
      return pending;
    },
  };
}
