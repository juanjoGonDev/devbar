/**
 * The phone's live link to DevBar: one /api/events stream (Server-Sent
 * Events) at a time, optionally subscribed to one process's log lines.
 *
 * When the stream drops — Wi-Fi blip, laptop asleep, DevBar restarting after
 * an update — it is closed for good and a new one is opened after a growing
 * pause (1, 2, 4, 8, then every 15 s). Before each attempt the server is
 * asked who we are: a device unlinked meanwhile stops here, and a DevBar that
 * came back as a different version needs a fresh copy of this page, not a
 * reconnect of the old one.
 */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const EVENTS = ['state', 'log', 'notice', 'confirm', 'update'] as const;

export interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
  close(): void;
}

export interface ConnectionDeps {
  openEvents(url: string): EventSourceLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Rejects while DevBar cannot be reached. */
  check(): Promise<'linked' | 'unlinked' | 'reload'>;
  onEvent(name: string, data: unknown): void;
  onStatus(status: 'live' | 'down'): void;
  onUnlinked(): void;
  reload(): void;
}

export interface Connection {
  /** (Re)opens the stream, subscribed to this process's logs (or none). */
  watch(logsId: string | null): void;
  close(): void;
}

function parse(data: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof data !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(data) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createConnection(deps: ConnectionDeps): Connection {
  let source: EventSourceLike | null = null;
  let logsId: string | null = null;
  let retry: unknown = null;
  let attempt = 0;

  const stop = (): void => {
    source?.close();
    source = null;
    if (retry !== null) deps.clearTimeout(retry);
    retry = null;
  };

  function scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0;
    attempt += 1;
    retry = deps.setTimeout(() => {
      retry = null;
      deps.check().then(
        (verdict) => {
          if (verdict === 'unlinked') deps.onUnlinked();
          else if (verdict === 'reload') deps.reload();
          else open();
        },
        () => scheduleRetry(),
      );
    }, delay);
  }

  function open(): void {
    const url =
      logsId === null
        ? '/api/events'
        : `/api/events?logs=${encodeURIComponent(logsId)}`;
    const current = deps.openEvents(url);
    source = current;
    /** Only the stream in use may act; a replaced one is ignored. */
    const live =
      (fn: (data?: unknown) => void) => (event: { data?: unknown }) => {
        if (source === current) fn(event.data);
      };
    current.addEventListener(
      'open',
      live(() => {
        attempt = 0;
        deps.onStatus('live');
      }),
    );
    current.addEventListener(
      'error',
      live(() => {
        stop();
        deps.onStatus('down');
        scheduleRetry();
      }),
    );
    current.addEventListener(
      'unlinked',
      live(() => {
        stop();
        deps.onUnlinked();
      }),
    );
    for (const name of EVENTS)
      current.addEventListener(
        name,
        live((data) => {
          const parsed = parse(data);
          if (parsed.ok) deps.onEvent(name, parsed.value);
        }),
      );
  }

  return {
    watch: (next) => {
      if (source && next === logsId) return;
      logsId = next;
      stop();
      open();
    },
    close: () => {
      stop();
      attempt = 0;
    },
  };
}
