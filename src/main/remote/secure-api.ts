import crypto from 'node:crypto';
import type { RemoteDeviceView } from '../../ipc-contract/remote-api.js';
import type { ApiRequest, ApiResponse } from './api.js';
import type { EventSink } from './events.js';
import { readSessionId } from './http-guard.js';
import type { IdentityKeys } from './identity.js';
import type { LiveStream } from './live.js';
import type { RateLimiter } from './rate-limit.js';
import {
  ephemeralKeyPair,
  EVENTS_PROOF,
  fromB64,
  KEY_BYTES,
  PROTOCOL_VERSION,
  SID_BYTES,
  sessionKeys,
  toB64,
  transcript,
} from './rc-protocol.js';
import type { Rpc } from './rpc.js';
import type { Session, SessionTable } from './sessions.js';
import type { StreamAnswer, StreamSink } from './server.js';
import { record } from './validate.js';

/**
 * The encrypted transport of «Control remoto» (devbar-rc/1, described in
 * src/main/remote/rc-protocol.ts) — the only three API endpoints there are:
 *
 *   POST /api/hello   {v, c} → {s, sid, id, sig}: a handshake, a session;
 *   POST /api/rpc     X-DevBar-Session + {n, ct}: one sealed call, opened,
 *                     handed to src/main/remote/rpc.ts, its answer sealed
 *                     with this session's own counter and naming the call it
 *                     answers (`re`: the call's counter);
 *   GET  /api/events  ?sid=…&n=…&ct=…: the live stream of an authenticated
 *                     session. The sid is in clear, so it is no credential:
 *                     `ct` seals "events" under the session's phone→desktop
 *                     key, through the same replay window as the calls. Every
 *                     event is sealed (`event: m`), so not even its type
 *                     shows; heartbeats stay plain SSE comments.
 *
 * A session answers only to the address that shook hands, and only a message
 * that opened counts as its activity. Refusals say as little as possible: a
 * message that does not open is a bare 400, and an unknown, expired or
 * foreign session is 401 `session`, which tells the phone to shake hands
 * again.
 */

const HELLO = '/api/hello';
const RPC = '/api/rpc';
const EVENTS_QUERY = ['ct', 'n', 'sid'];
/** A counter as the query carries it: a positive decimal, no padding. */
const COUNTER = /^[1-9]\d{0,15}$/;

export interface SecureApiDeps {
  identity: Pick<IdentityKeys, 'publicKey' | 'sign'>;
  sessions: SessionTable;
  /** Handshakes per address. */
  limiter: RateLimiter;
  dispatch: Rpc;
  /** The live stream of an authenticated session. */
  stream(session: Session, device: RemoteDeviceView): LiveStream;
  device(id: string): RemoteDeviceView | null;
  randomBytes?: (size: number) => Buffer;
}

export interface SecureApi {
  /** Every API request but the event stream. */
  route(request: ApiRequest): ApiResponse | Promise<ApiResponse>;
  events(request: ApiRequest): StreamAnswer;
}

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});
const badRequest = (): ApiResponse => json(400, { error: 'bad-request' });
const lostSession = (): ApiResponse => json(401, { error: 'session' });

/** Wraps the raw stream so every event leaves sealed for its session. */
function sealedSink(session: Session, raw: StreamSink): EventSink {
  return {
    event: (type, data) => {
      const payload = Buffer.from(JSON.stringify({ type, data }));
      return raw.write(`event: m\ndata: ${session.sealEvent(payload)}\n\n`);
    },
    heartbeat: () => raw.write(': heartbeat\n\n'),
    end: () => raw.end(),
  };
}

export function createSecureApi(deps: SecureApiDeps): SecureApi {
  const randomBytes = deps.randomBytes ?? ((size) => crypto.randomBytes(size));

  function hello(request: ApiRequest): ApiResponse {
    if (!deps.limiter.allow(request.ip))
      return json(429, { error: 'rate-limited' });
    const body = record(request.body);
    const clientPub = fromB64(body?.c, KEY_BYTES);
    if (body?.v !== PROTOCOL_VERSION || !clientPub) return badRequest();
    const mine = ephemeralKeyPair();
    const shared = mine.agree(clientPub);
    if (!shared) return badRequest();
    const sidBytes = randomBytes(SID_BYTES);
    const identityPub = deps.identity.publicKey();
    const handshake = transcript(
      identityPub,
      clientPub,
      mine.publicKey,
      sidBytes,
    );
    const sid = toB64(sidBytes);
    const session = deps.sessions.create(request.ip, {
      sid,
      transcript: handshake,
      keys: sessionKeys(shared, handshake),
    });
    if (!session) return json(503, { error: 'busy' });
    return json(200, {
      s: toB64(mine.publicKey),
      sid,
      id: toB64(identityPub),
      sig: toB64(deps.identity.sign(handshake)),
    });
  }

  /** The decrypted `{op, args}` of a sealed call, and its counter; or null. */
  function openCall(
    session: Session,
    body: unknown,
  ): { op: string; args: unknown; n: number } | null {
    const message = record(body);
    const counter = message?.n;
    const sealed = fromB64(message?.ct);
    if (typeof counter !== 'number' || !sealed) return null;
    const plaintext = session.open('rpc', counter, sealed);
    if (!plaintext) return null;
    try {
      const call = record(JSON.parse(plaintext.toString('utf8')));
      return typeof call?.op === 'string'
        ? { op: call.op, args: call.args, n: counter }
        : null;
    } catch {
      return null;
    }
  }

  /** Whether the stream's query proves it comes from the session's phone. */
  function provesEvents(session: Session, query: URLSearchParams): boolean {
    const counter = query.get('n') ?? '';
    const sealed = fromB64(query.get('ct'));
    if (!COUNTER.test(counter) || !sealed) return false;
    const plaintext = session.open('events', Number(counter), sealed);
    return plaintext?.toString('utf8') === EVENTS_PROOF;
  }

  async function rpc(request: ApiRequest): Promise<ApiResponse> {
    const session = request.sessionId
      ? deps.sessions.get(request.sessionId, request.ip)
      : null;
    if (!session) return lostSession();
    const call = openCall(session, request.body);
    if (!call) return badRequest();
    deps.sessions.touch(session);
    const answer = await deps.dispatch(call.op, call.args, {
      session,
      ip: request.ip,
      userAgent: request.userAgent,
    });
    // Sealed with the session in hand: an answer that just dropped this
    // very session (an unlink, a new device key) still reaches the phone.
    const plaintext = Buffer.from(
      JSON.stringify({ re: call.n, status: answer.status, body: answer.body }),
    );
    return json(200, session.seal(plaintext));
  }

  return {
    route: (request) => {
      const known = request.pathname === HELLO || request.pathname === RPC;
      if (!known) return json(404, { error: 'not-found' });
      if (request.method !== 'POST')
        return json(405, { error: 'method-not-allowed' });
      return request.pathname === HELLO ? hello(request) : rpc(request);
    },

    events: (request) => {
      const keys = [...request.query.keys()].sort();
      if (keys.join() !== EVENTS_QUERY.join()) return badRequest();
      const sid = readSessionId(request.query.get('sid') ?? undefined);
      const session = sid ? deps.sessions.get(sid, request.ip) : null;
      if (!session) return lostSession();
      if (!provesEvents(session, request.query)) return badRequest();
      deps.sessions.touch(session);
      const device = session.deviceId ? deps.device(session.deviceId) : null;
      if (!device) return json(403, { error: 'forbidden' });
      const answer = deps.stream(session, device);
      if (!('open' in answer)) return answer;
      return {
        open: (raw) => {
          deps.sessions.streamOpened(session);
          const detach = answer.open(sealedSink(session, raw));
          return () => {
            detach();
            deps.sessions.streamClosed(session);
          };
        },
      };
    },
  };
}
