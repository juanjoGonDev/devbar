import {
  aad,
  createReplayWindow,
  open,
  seal,
  sealEvent,
  toB64,
} from './rc-protocol.js';

/**
 * The devbar-rc/1 sessions, in memory only: one per handshake, each with its
 * own pair of keys, a counter for what the desktop sends and a replay window
 * over what the phone sends (calls and event-stream proofs share it). A
 * restart, a port change, an unlinked device or a renewed identity drops
 * them, and the phone simply shakes hands again — which is also what gives
 * every connection fresh keys.
 *
 * The sid travels in clear, so it names a session without being a key to it:
 * a session answers only to the address that shook hands, and only a message
 * that authenticated counts as activity (`touch`) — a lookup does not.
 *
 * A session that has carried no traffic for ten minutes, and holds no open
 * event stream, is forgotten. A few per address and a ceiling overall keep a
 * misbehaving page from piling them up: at a cap, the least recently used
 * idle session makes room, and only when every one is streaming is a new
 * handshake refused.
 */

const IDLE_MS = 10 * 60_000;
const PER_IP = 8;
const TOTAL = 32;

interface SessionMaterial {
  sid: string;
  transcript: Buffer;
  keys: { c2s: Buffer; s2c: Buffer };
}

/** What a phone→desktop message is: a call, or the proof opening a stream. */
type InboundKind = 'rpc' | 'events';

export interface Session {
  readonly id: string;
  readonly ip: string;
  /** The signed handshake transcript T, which an auth proof is bound to. */
  readonly transcript: Buffer;
  /** The linked device this session proved to be, once it did. */
  deviceId: string | null;
  /** The process whose log lines this session's stream carries. */
  logsId: string | null;
  /** It spent a pairing code (`pair.claim`): one per session. */
  pairClaimed: boolean;
  /** One phone→desktop message; null when forged, tampered or replayed. */
  open(kind: InboundKind, counter: number, sealed: Uint8Array): Buffer | null;
  /** One desktop→phone reply, with the next counter. */
  seal(plaintext: Uint8Array): { n: number; ct: string };
  /** One desktop→phone event (an SSE `data:` payload). */
  sealEvent(plaintext: Uint8Array): string;
}

interface Entry {
  session: Session;
  lastActivity: number;
  streams: number;
}

export interface SessionTableDeps {
  now(): number;
  perIp?: number;
  total?: number;
}

export interface SessionTable {
  /** Null when a cap is full of sessions that are all streaming. */
  create(ip: string, material: SessionMaterial): Session | null;
  /** The live session that `ip` shook hands from, or null. Not activity. */
  get(id: string, ip: string): Session | null;
  /** The session just carried a message that authenticated. */
  touch(session: Session): void;
  streamOpened(session: Session): void;
  streamClosed(session: Session): void;
  /** Drops that device's sessions; their ids. */
  dropDevice(deviceId: string): string[];
  /** Drops every session; their ids. */
  dropAll(): string[];
  size(): number;
}

function createSession(ip: string, material: SessionMaterial): Session {
  const { sid, keys } = material;
  const replay = createReplayWindow();
  const inbound: Record<InboundKind, Buffer> = {
    rpc: aad('c2s-rpc', sid),
    events: aad('c2s-events', sid),
  };
  const replies = aad('s2c-rpc', sid);
  const events = aad('s2c-evt', sid);
  let sent = 0;
  return {
    id: sid,
    ip,
    transcript: material.transcript,
    deviceId: null,
    logsId: null,
    pairClaimed: false,
    open: (kind, counter, sealed) => {
      // The window is checked first and only moves once the message
      // authenticated: a forged counter cannot push genuine ones out.
      if (!replay.fresh(counter)) return null;
      const plaintext = open(keys.c2s, counter, inbound[kind], sealed);
      if (plaintext) replay.mark(counter);
      return plaintext;
    },
    seal: (plaintext) => {
      sent += 1;
      return { n: sent, ct: toB64(seal(keys.s2c, sent, replies, plaintext)) };
    },
    sealEvent: (plaintext) => {
      sent += 1;
      return sealEvent(keys.s2c, sent, events, plaintext);
    },
  };
}

export function createSessionTable(deps: SessionTableDeps): SessionTable {
  const perIp = deps.perIp ?? PER_IP;
  const total = deps.total ?? TOTAL;
  const entries = new Map<string, Entry>();

  const expired = (entry: Entry, now: number): boolean =>
    entry.streams === 0 && now - entry.lastActivity >= IDLE_MS;

  const sweep = (): void => {
    const now = deps.now();
    for (const [id, entry] of entries)
      if (expired(entry, now)) entries.delete(id);
  };

  /** Makes room among `candidates`; false when all of them are streaming. */
  const evictOne = (candidates: Entry[]): boolean => {
    const idle = candidates
      .filter((entry) => entry.streams === 0)
      .sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (!idle) return false;
    entries.delete(idle.session.id);
    return true;
  };

  const drop = (match: (entry: Entry) => boolean): string[] => {
    const dropped = [...entries.values()]
      .filter(match)
      .map((e) => e.session.id);
    for (const id of dropped) entries.delete(id);
    return dropped;
  };

  const entryOf = (session: Session): Entry | undefined => {
    const entry = entries.get(session.id);
    return entry?.session === session ? entry : undefined;
  };

  return {
    create: (ip, material) => {
      sweep();
      const sameIp = [...entries.values()].filter((e) => e.session.ip === ip);
      if (sameIp.length >= perIp && !evictOne(sameIp)) return null;
      if (entries.size >= total && !evictOne([...entries.values()]))
        return null;
      const session = createSession(ip, material);
      entries.set(session.id, {
        session,
        lastActivity: deps.now(),
        streams: 0,
      });
      return session;
    },
    get: (id, ip) => {
      const entry = entries.get(id);
      if (!entry) return null;
      if (expired(entry, deps.now())) {
        entries.delete(id);
        return null;
      }
      return entry.session.ip === ip ? entry.session : null;
    },
    touch: (session) => {
      const entry = entryOf(session);
      if (entry) entry.lastActivity = deps.now();
    },
    streamOpened: (session) => {
      const entry = entryOf(session);
      if (entry) entry.streams += 1;
    },
    streamClosed: (session) => {
      const entry = entryOf(session);
      if (!entry) return;
      entry.streams = Math.max(0, entry.streams - 1);
      entry.lastActivity = deps.now();
    },
    dropDevice: (deviceId) => drop((e) => e.session.deviceId === deviceId),
    dropAll: () => drop(() => true),
    size: () => entries.size,
  };
}
