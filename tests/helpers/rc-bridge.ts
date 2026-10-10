import type { ApiRequest, ApiResponse } from '../../src/main/remote/api.js';
import { readSessionId } from '../../src/main/remote/http-guard.js';
import type { StreamAnswer, StreamSink } from '../../src/main/remote/server.js';
import type { Fetcher } from '../../renderer/remote/channel.js';

/**
 * The phone's real network code (renderer/remote/channel.ts, @noble crypto)
 * wired straight into the desktop's request handlers (node:crypto), the way
 * src/main/remote/server.ts would hand them a request — minus the socket.
 * Every test that goes through here exercises both implementations of
 * devbar-rc/1 against each other.
 */

export interface BridgeTarget {
  api(request: ApiRequest): ApiResponse | Promise<ApiResponse>;
  stream?(request: ApiRequest): StreamAnswer;
}

interface BridgedStream {
  url: string;
  refused: ApiResponse | null;
  /** The `data:` payload of every `event: m` frame, in order. */
  frames: string[];
  /** Raw SSE text, heartbeats included. */
  chunks: string[];
  ended(): boolean;
  close(): void;
}

export interface Bridge {
  fetch: Fetcher;
  /** Every request the phone made: method, path and the session header. */
  log: { method: string; url: string; sessionId: string | null }[];
  /** The sealed bodies of every /api/rpc call, as sent. */
  sent: { n: number; ct: string }[];
  openStream(url: string): BridgedStream;
}

const PHONE_IP = '192.168.1.40';
const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find(
    (each) => each.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : headers[key];
}

function request(
  url: string,
  init: RequestInit | undefined,
  ip: string,
): ApiRequest {
  const parsed = new URL(url, 'http://devbar.invalid');
  const method = init?.method ?? 'GET';
  return {
    method,
    pathname: parsed.pathname,
    query: parsed.searchParams,
    sessionId: readSessionId(headerOf(init, 'X-DevBar-Session')),
    ip,
    userAgent: PHONE_UA,
    body:
      method === 'POST'
        ? (JSON.parse(String(init?.body ?? 'null')) as unknown)
        : undefined,
  };
}

export function bridge(
  target: () => BridgeTarget,
  options: { ip?: string } = {},
): Bridge {
  const ip = options.ip ?? PHONE_IP;
  const log: Bridge['log'] = [];
  const sent: Bridge['sent'] = [];
  return {
    log,
    sent,
    fetch: async (url, init) => {
      const vetted = request(url, init, ip);
      log.push({ method: vetted.method, url, sessionId: vetted.sessionId });
      if (vetted.pathname === '/api/rpc')
        sent.push(vetted.body as { n: number; ct: string });
      const answer = await target().api(vetted);
      // What crosses the wire is JSON text, never shared objects.
      const body = JSON.parse(JSON.stringify(answer.body)) as unknown;
      return { status: answer.status, json: () => Promise.resolve(body) };
    },
    openStream: (url) => {
      const chunks: string[] = [];
      let ended = false;
      const answer = target().stream?.(request(url, undefined, ip));
      if (!answer) throw new Error('no stream handler');
      const result: BridgedStream = {
        url,
        refused: 'open' in answer ? null : answer,
        chunks,
        get frames() {
          return chunks
            .filter((chunk) => chunk.startsWith('event: m\n'))
            .map((chunk) => chunk.split('\n')[1]?.slice('data: '.length) ?? '');
        },
        ended: () => ended,
        close: () => undefined,
      };
      if (!('open' in answer)) return result;
      const sink: StreamSink = {
        write: (chunk) => {
          chunks.push(chunk);
          return true;
        },
        end: () => {
          ended = true;
        },
      };
      const detach = answer.open(sink);
      result.close = () => {
        ended = true;
        detach();
      };
      return result;
    },
  };
}
