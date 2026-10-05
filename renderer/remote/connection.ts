import type { EventReader } from './channel.js';

/**
 * The phone's live link to DevBar: one /api/events stream (Server-Sent
 * Events) at a time, on the current devbar-rc/1 session. Every event arrives
 * sealed (`event: m`) and is opened by that session's reader; which
 * process's log lines it carries is a call (`logs.subscribe`), not part of
 * the URL, so switching processes never reopens the stream.
 *
 * When the stream drops — Wi-Fi blip, laptop asleep, DevBar restarting after
 * an update — it is closed for good and a new one is opened after a growing
 * pause (1, 2, 4, 8, then every 15 s). Each attempt starts with a fresh
 * handshake (fresh keys) and asks who we are: a device unlinked meanwhile
 * stops here, a changed identity key is the app's to handle, and a DevBar
 * that came back as a different version needs a fresh copy of this page.
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

/** `lost`: trust is gone (a changed key, an unknown device) — the app took over. */
export type Verdict = 'linked' | 'unlinked' | 'reload' | 'lost';

export interface ConnectionDeps {
  openEvents(url: string): EventSourceLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The reader for a stream on the current session; null without one. */
  events(): EventReader | null;
  /** Shakes hands again and says who we are; rejects while unreachable. */
  check(): Promise<Verdict>;
  /** Points the session's stream at one process's lines, or none. */
  subscribe(logsId: string | null): Promise<unknown>;
  onEvent(name: string, data: unknown): void;
  onStatus(status: 'live' | 'down'): void;
  onUnlinked(): void;
  reload(): void;
}

export interface Connection {
  /** Opens the stream if needed, subscribed to this process's logs (or none). */
  watch(logsId: string | null): void;
  close(): void;
}

export function createConnection(deps: ConnectionDeps): Connection {
  let source: EventSourceLike | null = null;
  let logsId: string | null = null;
  let retry: unknown = null;
  let attempt = 0;
  let closed = false;

  const stop = (): void => {
    source?.close();
    source = null;
    if (retry !== null) deps.clearTimeout(retry);
    retry = null;
  };

  const subscribe = (): void => {
    void deps.subscribe(logsId).catch(() => undefined);
  };

  function scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 0;
    attempt += 1;
    retry = deps.setTimeout(() => {
      retry = null;
      deps.check().then(
        (verdict) => {
          if (closed) return;
          if (verdict === 'unlinked') deps.onUnlinked();
          else if (verdict === 'reload') deps.reload();
          else if (verdict === 'linked') open();
        },
        () => {
          if (!closed) scheduleRetry();
        },
      );
    }, delay);
  }

  const down = (): void => {
    stop();
    deps.onStatus('down');
    scheduleRetry();
  };

  function open(): void {
    const reader = deps.events();
    if (!reader) {
      down();
      return;
    }
    // A new session carries no subscription yet.
    if (logsId !== null) subscribe();
    const current = deps.openEvents(reader.url);
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
    current.addEventListener('error', live(down));
    current.addEventListener(
      'm',
      live((data) => {
        const message = reader.read(data);
        if (!message) return;
        if (message.type === 'unlinked') {
          stop();
          deps.onUnlinked();
        } else if ((EVENTS as readonly string[]).includes(message.type))
          deps.onEvent(message.type, message.data);
      }),
    );
  }

  return {
    watch: (next) => {
      closed = false;
      const changed = next !== logsId;
      logsId = next;
      if (source) {
        if (changed) subscribe();
      } else if (retry === null) open();
    },
    close: () => {
      closed = true;
      stop();
      attempt = 0;
    },
  };
}
