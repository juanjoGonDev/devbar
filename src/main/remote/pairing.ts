import crypto from 'node:crypto';
import type { RemotePairRequest } from '../../ipc-contract/remote-api.js';

/**
 * The pairing handshake, as a pure state machine (clock and randomness are
 * injected):
 *
 *   1. The desktop issues THE pairing code — one at a time, single use,
 *      30 seconds. It travels in the QR's fragment, so it proves the phone
 *      saw this screen and never crosses the network in clear.
 *   2. The phone claims it right after its handshake (`claim`): the code is
 *      spent there, and that session — only that one — holds a claim for
 *      two minutes, the time to name the device. So a code can last only
 *      seconds on screen without rushing whoever types the name.
 *   3. The claim is redeemed for a request: a 60 s window and a 6-digit
 *      verification number that only the phone shows. Seeing the code is not
 *      enough — someone at the desk must type those digits (`checkCode`,
 *      compared in constant time), which is what tells them they accept THEIR
 *      phone and not a neighbour who photographed the screen first. Three
 *      wrong codes reject the request; accepting re-checks the digits.
 *   4. The phone polls the request; the server hands an accepted one over
 *      exactly once (`takeAccepted`), which is when the device is created
 *      with the public key the phone sent along (devbar-rc/1: the phone
 *      proves it holds the matching private key on every connection) — and
 *      when the device it replaces, if its old key proved it is the same
 *      phone pairing again, is removed (src/main/remote/api.ts).
 *
 * Nothing here is persisted: a restart drops every code, claim and request.
 */

const CODE_TTL_MS = 30_000;
/** How long a claimed code leaves its session to send the request. */
const CLAIM_TTL_MS = 2 * 60_000;
const REQUEST_TTL_MS = 60_000;
/** How long a settled request stays readable for the phone's next poll. */
const SETTLED_RETENTION_MS = 60_000;
/** Recently retired codes, remembered only to explain a refusal. */
const RETIRED_MEMORY = 8;
/** Wrong codes typed on the desktop before the request is rejected. */
const CODE_ATTEMPTS = 3;
const SIX_DIGITS = /^\d{6}$/;

type PairRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';
type PairCodeRefusal = 'invalid' | 'expired' | 'used';
/** No live claim on that session: never made, lapsed or already spent. */
type PairClaimRefusal = 'claim-expired';

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
  /** Spends the code for session `sid`, which may then send its request. */
  claim(input: {
    code: string;
    sid: string;
  }): { ok: true; expiresAt: number } | { ok: false; reason: PairCodeRefusal };
  /** Redeems the live claim of session `sid`. */
  request(input: {
    sid: string;
    name: string;
    client: string;
    ip: string;
    /** The phone's Ed25519 public key, base64url. */
    devicePub: string;
    /** The device this pairing replaces, its old key already proven. */
    replaces?: Replaced | null;
  }):
    | {
        ok: true;
        request: RemotePairRequest;
        verificationCode: string;
        /** Time left, for a phone whose clock may not agree with this one. */
        expiresInMs: number;
      }
    | { ok: false; reason: PairClaimRefusal };
  /** Null once the request is unknown, handed over or forgotten. */
  status(requestId: string): PairRequestStatus | null;
  /**
   * The digits typed on the desktop against the phone's; the third wrong
   * six-digit code rejects the request. Null when it is not pending.
   */
  checkCode(
    requestId: string,
    typed: string,
  ): { match: boolean; attemptsLeft: number } | null;
  /** Accepting needs the phone's digits; rejecting needs nothing. */
  respond(
    requestId: string,
    accept: boolean,
    typed: string,
  ): 'ok' | 'not-pending' | 'mismatch';
  takeAccepted(requestId: string): AcceptedRequest | null;
  /** The phone gave up on a pending request; true when it was pending. */
  withdraw(requestId: string): boolean;
  /** Expires a pending request that is due; true when it just expired. */
  expire(requestId: string): boolean;
  /** Drops the code, every claim and every request; the pending ids. */
  clear(): string[];
}

/** A linked device, and the key it proved to hold when it was named. */
interface Replaced {
  deviceId: string;
  devicePub: string;
}

/**
 * An accepted request, with the key the new device will be known by and the
 * device it replaces, if any.
 */
type AcceptedRequest = RemotePairRequest & {
  devicePub: string;
  replaces: Replaced | null;
};

interface Entry {
  request: RemotePairRequest;
  verificationCode: string;
  devicePub: string;
  replaces: Replaced | null;
  status: PairRequestStatus;
  settledAt: number | null;
  attemptsLeft: number;
}

/** What was typed, without the space the digits are shown with. */
const digitsOf = (typed: string): string => typed.replace(/\s/g, '');

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
  /** Live claims: session id → when the claim lapses. */
  const claims = new Map<string, number>();

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

  const settleAs = (entry: Entry, status: PairRequestStatus): void => {
    entry.status = status;
    entry.settledAt = deps.now();
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
    claim: ({ code, sid }) => {
      const now = deps.now();
      for (const [id, lapsesAt] of claims)
        if (now >= lapsesAt) claims.delete(id);
      if (!active || !sameSecret(active.code, code) || now >= active.expiresAt)
        return { ok: false, reason: refusal(code) };
      retire(active.code, 'used');
      active = null;
      const expiresAt = now + CLAIM_TTL_MS;
      claims.set(sid, expiresAt);
      return { ok: true, expiresAt };
    },
    request: ({ sid, name, client, ip, devicePub, replaces = null }) => {
      const now = deps.now();
      const lapsesAt = claims.get(sid);
      claims.delete(sid);
      if (lapsesAt === undefined || now >= lapsesAt)
        return { ok: false, reason: 'claim-expired' };
      const request: RemotePairRequest = {
        requestId: randomBytes(16).toString('base64url'),
        name,
        client,
        ip,
        expiresAt: now + REQUEST_TTL_MS,
      };
      const verificationCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
      entries.set(request.requestId, {
        request,
        verificationCode,
        devicePub,
        replaces,
        status: 'pending',
        settledAt: null,
        attemptsLeft: CODE_ATTEMPTS,
      });
      return {
        ok: true,
        request: { ...request },
        verificationCode,
        expiresInMs: request.expiresAt - now,
      };
    },
    status: (requestId) => settle(requestId)?.status ?? null,
    checkCode: (requestId, typed) => {
      const entry = settle(requestId);
      if (entry?.status !== 'pending') return null;
      const digits = digitsOf(typed);
      const match = sameSecret(digits, entry.verificationCode);
      if (!match && SIX_DIGITS.test(digits)) {
        entry.attemptsLeft -= 1;
        if (entry.attemptsLeft === 0) settleAs(entry, 'rejected');
      }
      return { match, attemptsLeft: entry.attemptsLeft };
    },
    respond: (requestId, accept, typed) => {
      const entry = settle(requestId);
      if (entry?.status !== 'pending') return 'not-pending';
      if (accept && !sameSecret(digitsOf(typed), entry.verificationCode))
        return 'mismatch';
      settleAs(entry, accept ? 'accepted' : 'rejected');
      return 'ok';
    },
    takeAccepted: (requestId) => {
      const entry = settle(requestId);
      if (entry?.status !== 'accepted') return null;
      entries.delete(requestId);
      return {
        ...entry.request,
        devicePub: entry.devicePub,
        replaces: entry.replaces,
      };
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
      claims.clear();
      const pending = [...entries.values()]
        .filter((entry) => entry.status === 'pending')
        .map((entry) => entry.request.requestId);
      entries.clear();
      return pending;
    },
  };
}
