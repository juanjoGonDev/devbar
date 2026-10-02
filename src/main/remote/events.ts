import type { RemoteLogLine } from '../../ipc-contract/remote-wire.js';
import type { TimerHandle, Timers } from './timers.js';

/**
 * The open /api/events streams (Server-Sent Events) of the linked phones,
 * and the fan-out over them. The hub only knows streams and frames: who may
 * open one, and what goes in each event, is decided by its caller.
 *
 * Limits keep a misbehaving page from holding the process hostage: a few
 * streams per device, a ceiling overall, and a client whose socket buffer
 * stops draining is dropped (it reconnects and starts from a fresh state).
 * Log lines are batched every 100 ms per process, so a chatty build does
 * not turn into one write per line per phone.
 */

const HEARTBEAT_MS = 25_000;
const LOG_FLUSH_MS = 100;
/** A burst beyond this is trimmed to its newest lines: the phone shows a tail. */
const LOG_BATCH_MAX = 500;

export interface EventSink {
  /** False when the client cannot keep up: the hub drops it. */
  write(chunk: string): boolean;
  end(): void;
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
  canAttach(deviceId: string): boolean;
  /** Null when a limit is reached (check `canAttach` first). */
  attach(
    deviceId: string,
    logsId: string | null,
    sink: EventSink,
  ): EventClient | null;
  broadcast(event: string, data: unknown): void;
  /** Whether any stream subscribed to this process's log lines. */
  watches(processId: string): boolean;
  log(processId: string, line: RemoteLogLine): void;
  /** Says `unlinked` to every stream of that device, then closes them. */
  drop(deviceId: string): void;
  closeAll(): void;
  isConnected(deviceId: string): boolean;
  hasClients(): boolean;
}

interface Client {
  deviceId: string;
  logsId: string | null;
  sink: EventSink;
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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

  function write(client: Client, chunk: string): void {
    if (client.sink.write(chunk)) return;
    remove(client);
    client.sink.end();
  }

  const canAttach = (deviceId: string): boolean =>
    clients.size < total && countFor(deviceId) < perDevice;
  const watches = (processId: string): boolean =>
    [...clients].some((client) => client.logsId === processId);

  function flushLogs(): void {
    flushTimer = null;
    for (const [id, lines] of pendingLogs)
      for (const client of [...clients])
        if (client.logsId === id) write(client, frame('log', { id, lines }));
    pendingLogs.clear();
  }

  return {
    canAttach,

    attach: (deviceId, logsId, sink) => {
      if (!canAttach(deviceId)) return null;
      const client: Client = { deviceId, logsId, sink };
      const first = countFor(deviceId) === 0;
      clients.add(client);
      heartbeat ??= timers.setInterval(() => {
        for (const each of [...clients]) write(each, ': heartbeat\n\n');
      }, HEARTBEAT_MS);
      if (first) deps.onPresenceChange(deviceId);
      return {
        send: (event, data) => {
          if (clients.has(client)) write(client, frame(event, data));
        },
        detach: () => remove(client),
      };
    },

    broadcast: (event, data) => {
      const chunk = frame(event, data);
      for (const client of [...clients]) write(client, chunk);
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
        client.sink.write(frame('unlinked', {}));
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
