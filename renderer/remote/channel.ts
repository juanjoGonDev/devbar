import {
  aad,
  authMessage,
  createReplayWindow,
  ephemeralKeyPair,
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
 * keys, sealed calls over POST /api/rpc, and a reader for the sealed frames
 * of GET /api/events. Who to trust and when to shake hands again is the
 * client's business (renderer/remote/api.ts); this only speaks the protocol.
 *
 * Each failure is a RemoteError with a code the client can act on:
 *   changed   the desktop answered with another identity key than expected;
 *   session   the desktop no longer knows this session (shake hands again);
 *   protocol  an answer that does not verify or decrypt — never trusted;
 *   http      DevBar answered something else (busy, rate-limited…);
 *   unlinked  set by the client when `auth` is refused.
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

export interface Channel {
  /** A fresh handshake with the desktop that holds `expected`. */
  open(expected: Uint8Array): Promise<void>;
  ready(): boolean;
  send(op: string, args?: unknown): Promise<Answer>;
  /** This device's auth proof for the current handshake (base64url). */
  proof(secretKey: Uint8Array): string;
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

/** One s2c message: checked against the window, opened, then recorded. */
function receive(
  session: Session,
  counter: number,
  sealed: Uint8Array,
): Record<string, unknown> | null {
  if (!session.replay.fresh(counter)) return null;
  const message = parse(
    open(session.s2c, counter, aad('s2c', session.sid), sealed),
  );
  if (message) session.replay.mark(counter);
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

  async function open(expected: Uint8Array): Promise<void> {
    session = null;
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
    const handshake = transcript(mine.publicKey, serverPub, sidBytes);
    if (!verifySignature(expected, handshake, signature))
      throw new RemoteError('protocol');
    const shared = mine.agree(serverPub);
    if (!shared) throw new RemoteError('protocol');
    session = {
      sid: toB64(sidBytes),
      handshake,
      ...sessionKeys(shared, handshake),
      sent: 0,
      replay: createReplayWindow(),
    };
  }

  async function send(op: string, args: unknown = {}): Promise<Answer> {
    const current = session;
    if (!current) throw new RemoteError('session');
    current.sent += 1;
    const n = current.sent;
    const plaintext = utf8(JSON.stringify({ op, args }));
    const ct = toB64(seal(current.c2s, n, aad('c2s', current.sid), plaintext));
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
    const message = receive(current, counter, sealed);
    if (!message || typeof message.status !== 'number')
      throw new RemoteError('protocol');
    return { status: message.status, body: record(message.body) };
  }

  return {
    open,
    ready: () => session !== null,
    send,
    proof: (secretKey) => {
      if (!session) throw new RemoteError('session');
      return toB64(sign(secretKey, authMessage(session.handshake)));
    },
    events: () => {
      // The reader keeps the session it was made for: a later handshake
      // does not change how this stream's frames are opened.
      const current = session;
      if (!current) return null;
      return {
        url: `/api/events?sid=${current.sid}`,
        read: (data) => {
          if (typeof data !== 'string') return null;
          const frame = openEvent(current.s2c, aad('s2c', current.sid), data);
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
