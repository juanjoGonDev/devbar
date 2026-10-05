import type { RemoteLogLine } from '../../ipc-contract/remote-wire.js';
import type { TimerHandle, Timers } from './timers.js';

/**
 * The open /api/events streams (Server-Sent Events) of the linked phones,
 * and the fan-out over them. The hub only knows streams and events: who may
 * open one, what goes in each event and how it is sealed for its session
 * (src/main/remote/secure-api.ts) is decided by its caller.
 *
 * Limits keep a misbehaving page from holding the process hostage: one
 * stream per session (a new one replaces the old, quietly), a few per
 * device, a ceiling overall, and a client whose socket buffer stops
 * draining is dropped (it reconnects and starts from a fresh state).
 * Log lines are batched every 100 ms per process, so a chatty build does
 * not turn into one write per line per phone.
 */

const HEARTBEAT_MS = 25_000;
const LOG_FLUSH_MS = 100;
/** A burst beyond this is trimmed to its newest lines: the phone shows a tail. */
const LOG_BATCH_MAX = 500;

export interface EventSink {
  /** One event; false when the client cannot keep up: the hub drops it. */
  event(type: string, data: unknown): boolean;
  /** A keep-alive; false like `event`. */
  heartbeat(): boolean;
  end(): void;
}

/** Who a stream belongs to, and which process's log lines it carries. */
export interface StreamOwner {
  deviceId: string;
  sessionId: string;
  logsId: string | null;
}

interface EventClient {
  send(event: string, data: unknown): void;
  /** The socket closed; safe to call more than once. */
  detach(): void;
}

export interface EventHubDeps {
  timers: Timers;
  /** A device opened its first stream or closed its last one. */
  onPresenceChange(deviceId: string): void;
  perDevice?: number;
  total?: number;
}

export interface EventHub {
  /** Room for this stream, counting the one of its session it replaces. */
  canAttach(owner: StreamOwner): boolean;
  /**
   * Null when a limit is reached (check `canAttach` first). An earlier
   * stream of the same session ends: one per session.
   */
  attach(owner: StreamOwner, sink: EventSink): EventClient | null;
  /** Points one session's streams at another process's lines, or none. */
  subscribe(sessionId: string, logsId: string | null): void;
  /** Ends those sessions' streams, quietly: the phone reconnects. */
  closeSessions(sessionIds: readonly string[]): void;
  /** To every stream; `exceptDevice`'s streams are left out. */
  broadcast(event: string, data: unknown, exceptDevice?: string): void;
  /** Whether any stream subscribed to this process's log lines. */
  watches(processId: string): boolean;
  log(processId: string, line: RemoteLogLine): void;
  /** Says `unlinked` to every stream of that device, then closes them. */
  drop(deviceId: string): void;
  closeAll(): void;
  isConnected(deviceId: string): boolean;
  hasClients(): boolean;
}

interface Client extends StreamOwner {
  sink: EventSink;
}

export function createEventHub(deps: EventHubDeps): EventHub {
  const perDevice = deps.perDevice ?? 3;
  const total = deps.total ?? 12;
  const { timers } = deps;
  const clients = new Set<Client>();
  const pendingLogs = new Map<string, RemoteLogLine[]>();
  let heartbeat: TimerHandle = null;
  let flushTimer: TimerHandle = null;

  const countFor = (deviceId: string): number =>
    [...clients].filter((client) => client.deviceId === deviceId).length;

  const stopTimers = (): void => {
    if (heartbeat !== null) timers.clearInterval(heartbeat);
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    heartbeat = null;
    flushTimer = null;
    pendingLogs.clear();
  };

  function remove(client: Client): void {
    if (!clients.delete(client)) return;
    if (clients.size === 0) stopTimers();
    if (countFor(client.deviceId) === 0) deps.onPresenceChange(client.deviceId);
  }

  /** Delivers through `send`; a client that cannot keep up is dropped. */
  function write(client: Client, send: (sink: EventSink) => boolean): void {
    if (send(client.sink)) return;
    remove(client);
    client.sink.end();
  }

  const canAttach = (owner: StreamOwner): boolean => {
    const others = [...clients].filter(
      (client) => client.sessionId !== owner.sessionId,
    );
    return (
      others.length < total &&
      others.filter((client) => client.deviceId === owner.deviceId).length <
        perDevice
    );
  };
  const watches = (processId: string): boolean =>
    [...clients].some((client) => client.logsId === processId);

  function flushLogs(): void {
    flushTimer = null;
    for (const [id, lines] of pendingLogs)
      for (const client of [...clients])
        if (client.logsId === id)
          write(client, (sink) => sink.event('log', { id, lines }));
    pendingLogs.clear();
  }

  return {
    canAttach,

    attach: (owner, sink) => {
      const { deviceId } = owner;
      if (!canAttach(owner)) return null;
      const client: Client = { ...owner, sink };
      const first = countFor(deviceId) === 0;
      const replaced = [...clients].find(
        (each) => each.sessionId === owner.sessionId,
      );
      if (replaced) {
        // Its own device keeps a stream throughout: no presence change.
        clients.delete(replaced);
        replaced.sink.end();
        if (replaced.deviceId !== deviceId && countFor(replaced.deviceId) === 0)
          deps.onPresenceChange(replaced.deviceId);
      }
      clients.add(client);
      heartbeat ??= timers.setInterval(() => {
        for (const each of [...clients]) write(each, (s) => s.heartbeat());
      }, HEARTBEAT_MS);
      if (first) deps.onPresenceChange(deviceId);
      return {
        send: (event, data) => {
          if (clients.has(client)) write(client, (s) => s.event(event, data));
        },
        detach: () => remove(client),
      };
    },

    subscribe: (sessionId, logsId) => {
      for (const client of clients)
        if (client.sessionId === sessionId) client.logsId = logsId;
    },

    closeSessions: (sessionIds) => {
      for (const client of [...clients]) {
        if (!sessionIds.includes(client.sessionId)) continue;
        remove(client);
        client.sink.end();
      }
    },

    broadcast: (event, data, exceptDevice) => {
      for (const client of [...clients])
        if (client.deviceId !== exceptDevice)
          write(client, (sink) => sink.event(event, data));
    },

    watches,

    log: (processId, line) => {
      if (!watches(processId)) return;
      const batch = pendingLogs.get(processId) ?? [];
      batch.push(line);
      if (batch.length > LOG_BATCH_MAX) batch.shift();
      pendingLogs.set(processId, batch);
      flushTimer ??= timers.setTimeout(flushLogs, LOG_FLUSH_MS);
    },

    drop: (deviceId) => {
      for (const client of [...clients]) {
        if (client.deviceId !== deviceId) continue;
        client.sink.event('unlinked', {});
        remove(client);
        client.sink.end();
      }
    },

    closeAll: () => {
      const all = [...clients];
      clients.clear();
      stopTimers();
      for (const client of all) client.sink.end();
      for (const deviceId of new Set(all.map((client) => client.deviceId)))
        deps.onPresenceChange(deviceId);
    },

    isConnected: (deviceId) => countFor(deviceId) > 0,
    hasClients: () => clients.size > 0,
  };
}
