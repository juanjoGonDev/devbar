import {
  aad,
  authMessage,
  createReplayWindow,
  ephemeralKeyPair,
  EVENTS_PROOF,
  fromB64,
  KEY_BYTES,
  open,
  openEvent,
  PROTOCOL_VERSION,
  sameBytes,
  seal,
  sessionKeys,
  SID_BYTES,
  sign,
  SIGNATURE_BYTES,
  toB64,
  transcript,
  utf8,
  verifySignature,
} from './rc-protocol.js';

/**
 * The phone's end of devbar-rc/1 (the protocol is described in
 * src/main/remote/rc-protocol.ts): one handshake → one session with fresh
 * keys — signed in as this device when it has one —, sealed calls over POST
 * /api/rpc, and the sealed proof and reader of GET /api/events. Who to trust
 * and when to shake hands again is the client's business
 * (renderer/remote/api.ts); this only speaks the protocol.
 *
 * A session is ready only once the whole handshake is done, sign-in
 * included: nothing can go out on a half-made one. Each reply must name the
 * call it answers (`re`), so a reply swapped onto another call is refused.
 *
 * Each failure is a RemoteError with a code the client can act on:
 *   changed   the desktop answered with another identity key than expected;
 *   session   the desktop no longer knows this session (shake hands again);
 *   protocol  an answer that does not verify or decrypt — never trusted;
 *   http      DevBar answered something else (busy, rate-limited…);
 *   unlinked  the sign-in was refused because the desktop does not know
 *             this device — the one answer that means it was unlinked.
 */

export type Fetcher = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type RemoteErrorCode =
  'changed' | 'session' | 'protocol' | 'http' | 'unlinked';

export class RemoteError extends Error {
  constructor(readonly code: RemoteErrorCode) {
    super(`devbar-rc: ${code}`);
    this.name = 'RemoteError';
  }
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export interface EventReader {
  url: string;
  /** One `data:` payload, opened; null when forged, replayed or garbled. */
  read(data: unknown): { type: string; data: unknown } | null;
}

/** A linked device, as it signs in. */
interface DeviceProof {
  id: string;
  secretKey: Uint8Array;
}

export interface Channel {
  /**
   * A fresh handshake with the desktop that holds `expected`, then the
   * sign-in of `device` when there is one. Ready only once both succeeded.
   */
  open(expected: Uint8Array, device?: DeviceProof | null): Promise<void>;
  ready(): boolean;
  send(op: string, args?: unknown): Promise<Answer>;
  /** The transcript T of the ready session, for a proof a call carries. */
  handshake(): Uint8Array | null;
  /** A stream on the ready session: its URL (with a fresh proof), its reader. */
  events(): EventReader | null;
  /** Forgets the session: the next `send` needs a new handshake. */
  close(): void;
}

interface Session {
  sid: string;
  handshake: Uint8Array;
  c2s: Uint8Array;
  s2c: Uint8Array;
  sent: number;
  replay: ReturnType<typeof createReplayWindow>;
}

const HEADERS = {
  'Content-Type': 'application/json',
  'X-DevBar-Request': '1',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parse(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === 'object' && value !== null ? record(value) : null;
  } catch {
    return null;
  }
}

async function readJson(response: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    return {};
  }
}

/**
 * The reply to call `re`: checked against the window, opened, matched to
 * the call, and only then recorded.
 */
function receive(
  session: Session,
  counter: number,
  sealed: Uint8Array,
  re: number,
): Record<string, unknown> | null {
  if (!session.replay.fresh(counter)) return null;
  const message = parse(
    open(session.s2c, counter, aad('s2c-rpc', session.sid), sealed),
  );
  if (!message || message.re !== re) return null;
  session.replay.mark(counter);
  return message;
}

export function createChannel(fetcher: Fetcher): Channel {
  let session: Session | null = null;

  const post = (url: string, body: unknown, sid?: string) =>
    fetcher(url, {
      method: 'POST',
      headers: sid ? { ...HEADERS, 'X-DevBar-Session': sid } : HEADERS,
      body: JSON.stringify(body),
    });

  async function exchange(
    current: Session,
    op: string,
    args: unknown,
  ): Promise<Answer> {
    current.sent += 1;
    const n = current.sent;
    const plaintext = utf8(JSON.stringify({ op, args }));
    const ct = toB64(
      seal(current.c2s, n, aad('c2s-rpc', current.sid), plaintext),
    );
    const response = await post('/api/rpc', { n, ct }, current.sid);
    const body = await readJson(response);
    if (response.status === 401 && body.error === 'session') {
      if (session === current) session = null;
      throw new RemoteError('session');
    }
    if (response.status !== 200) throw new RemoteError('http');
    const sealed = fromB64(body.ct);
    const counter = body.n;
    if (!sealed || typeof counter !== 'number')
      throw new RemoteError('protocol');
    const message = receive(current, counter, sealed, n);
    if (!message || typeof message.status !== 'number')
      throw new RemoteError('protocol');
    return { status: message.status, body: record(message.body) };
  }

  async function handshake(expected: Uint8Array): Promise<Session> {
    const mine = ephemeralKeyPair();
    const response = await post('/api/hello', {
      v: PROTOCOL_VERSION,
      c: toB64(mine.publicKey),
    });
    if (response.status !== 200) throw new RemoteError('http');
    const body = await readJson(response);
    const serverPub = fromB64(body.s, KEY_BYTES);
    const sidBytes = fromB64(body.sid, SID_BYTES);
    const id = fromB64(body.id, KEY_BYTES);
    const signature = fromB64(body.sig, SIGNATURE_BYTES);
    if (!serverPub || !sidBytes || !id || !signature)
      throw new RemoteError('protocol');
    // Pinning: another identity is a changed key, whatever it signed.
    if (!sameBytes(id, expected)) throw new RemoteError('changed');
    const t = transcript(expected, mine.publicKey, serverPub, sidBytes);
    if (!verifySignature(expected, t, signature))
      throw new RemoteError('protocol');
    const shared = mine.agree(serverPub);
    if (!shared) throw new RemoteError('protocol');
    return {
      sid: toB64(sidBytes),
      handshake: t,
      ...sessionKeys(shared, t),
      sent: 0,
      replay: createReplayWindow(),
    };
  }

  /** `auth` on a session that is not ready yet; throws when refused. */
  async function signIn(current: Session, device: DeviceProof): Promise<void> {
    const answer = await exchange(current, 'auth', {
      deviceId: device.id,
      sig: toB64(
        sign(device.secretKey, authMessage(device.id, current.handshake)),
      ),
    });
    if (answer.status === 200) return;
    throw new RemoteError(
      answer.status === 401 && answer.body.error === 'unknown-device'
        ? 'unlinked'
        : 'http',
    );
  }

  return {
    open: async (expected, device) => {
      session = null;
      const current = await handshake(expected);
      if (device) await signIn(current, device);
      session = current;
    },
    ready: () => session !== null,
    send: (op, args = {}) => {
      if (!session) return Promise.reject(new RemoteError('session'));
      return exchange(session, op, args);
    },
    handshake: () => session?.handshake ?? null,
    events: () => {
      // The reader keeps the session it was made for: a later handshake
      // does not change how this stream's frames are opened.
      const current = session;
      if (!current) return null;
      current.sent += 1;
      const n = current.sent;
      const proof = seal(
        current.c2s,
        n,
        aad('c2s-events', current.sid),
        utf8(EVENTS_PROOF),
      );
      const frames = aad('s2c-evt', current.sid);
      return {
        url: `/api/events?sid=${current.sid}&n=${n}&ct=${toB64(proof)}`,
        read: (data) => {
          if (typeof data !== 'string') return null;
          const frame = openEvent(current.s2c, frames, data);
          if (!frame || !current.replay.fresh(frame.counter)) return null;
          const message = parse(frame.plaintext);
          if (!message || typeof message.type !== 'string') return null;
          current.replay.mark(frame.counter);
          return { type: message.type, data: message.data };
        },
      };
    },
    close: () => {
      session = null;
    },
  };
}
