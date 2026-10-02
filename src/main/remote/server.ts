import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { ApiRequest, ApiResponse } from './api.js';
import type { EventSink } from './events.js';
import {
  checkMutation,
  HTML_CSP,
  readJsonBody,
  readSessionToken,
  SECURITY_HEADERS,
} from './http-guard.js';
import { isAllowedHost, normalizeIp } from './lan.js';
import { staticAsset } from './static-files.js';

/**
 * The remote-control HTTP server: node:http, listening on every interface
 * only while the user has the switch on. Each request clears the gates in
 * order — Host (421), method (405), mutation shape (403), body size (413) —
 * before it reaches the API or the static whitelist. Listen failures are
 * kept as a message for the config window; they never throw out of here.
 *
 * `GET /api/events` is the one response that stays open: a Server-Sent
 * Events stream, handed to `stream` once the same gates have passed.
 */

/** What `stream` answers: a refusal, or a stream to open. */
export type StreamAnswer = ApiResponse | { open(sink: EventSink): () => void };

export interface RemoteServerDeps {
  port: number;
  /** Where to bind; every interface by default. */
  listenHost?: string;
  /** This machine's LAN IPv4 addresses, read on every request. */
  addresses(): readonly string[];
  /** A whitelisted renderer build file, or null when it is missing. */
  readStatic(file: string): Buffer | null;
  api(request: ApiRequest): ApiResponse | Promise<ApiResponse>;
  /** GET /api/events; without it the path is an ordinary API route. */
  stream?(request: ApiRequest): StreamAnswer;
  /** Called after every start/stop, successful or not. */
  onStateChange(): void;
  /** `http.createServer` unless a test wants the instance. */
  createHttpServer?: (listener: http.RequestListener) => http.Server;
}

export interface RemoteServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  listening(): boolean;
  error(): string | null;
  /** The bound port while listening, else the configured one. */
  port(): number;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const EVENTS_PATH = '/api/events';
/** A stream whose socket buffer outgrows this is cut: it is not draining. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;

function listenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE')
    return `El puerto ${port} ya está en uso por otra aplicación.`;
  if (code === 'EACCES') return `Sin permiso para usar el puerto ${port}.`;
  const detail = error instanceof Error ? error.message : String(error);
  return `No se pudo abrir el puerto ${port}: ${detail}`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  setCookie?: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_TYPE);
  if (setCookie) res.setHeader('Set-Cookie', [setCookie]);
  res.end(JSON.stringify(body));
}

export function createRemoteServer(deps: RemoteServerDeps): RemoteServer {
  let server: http.Server | null = null;
  let listening = false;
  let error: string | null = null;

  const boundPort = (): number => {
    const address = server?.address();
    return address && typeof address === 'object' ? address.port : deps.port;
  };

  const apiRequest = (
    req: IncomingMessage,
    url: URL,
    method: string,
    body: unknown,
  ): ApiRequest => ({
    method,
    pathname: url.pathname,
    query: url.searchParams,
    token: readSessionToken(req.headers.cookie),
    ip: normalizeIp(req.socket.remoteAddress),
    userAgent: req.headers['user-agent'],
    body,
  });

  function openStream(
    req: IncomingMessage,
    res: ServerResponse,
    answer: StreamAnswer,
  ): void {
    if (!('open' in answer)) {
      sendJson(res, answer.status, answer.body, answer.setCookie);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Proxies and some mobile browsers buffer a stream without this.
      'X-Accel-Buffering': 'no',
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    const detach = answer.open({
      write: (chunk) => {
        res.write(chunk);
        if (res.writableLength <= MAX_BUFFERED_BYTES) return true;
        res.destroy();
        return false;
      },
      end: () => res.end(),
    });
    res.on('close', detach);
  }

  async function routeApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    if (method === 'GET' && url.pathname === EVENTS_PATH && deps.stream) {
      openStream(req, res, deps.stream(apiRequest(req, url, method, null)));
      return;
    }
    let body: unknown;
    if (method === 'POST') {
      const read = await readJsonBody(req, req.headers['content-length']);
      if (!read.ok) {
        // An unread body must not be drained forever: drop the connection.
        res.setHeader('Connection', 'close');
        sendJson(res, read.status, {
          error: read.status === 413 ? 'too-large' : 'invalid-json',
        });
        return;
      }
      body = read.value;
    }
    const answer = await deps.api(apiRequest(req, url, method, body));
    sendJson(res, answer.status, answer.body, answer.setCookie);
  }

  function serveStatic(res: ServerResponse, url: URL): void {
    const asset = staticAsset(url.pathname);
    const content = asset ? deps.readStatic(asset.file) : null;
    if (!asset || !content) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', asset.type);
    if (asset.type.startsWith('text/html'))
      res.setHeader('Content-Security-Policy', HTML_CSP);
    res.end(content);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      res.setHeader(name, value);
    if (!isAllowedHost(req.headers.host, deps.addresses(), boundPort()))
      return sendJson(res, 421, { error: 'misdirected' });
    const method = req.method ?? '';
    // No OPTIONS branch on purpose: a CORS preflight gets a plain 405 with
    // no Access-Control-* header, so a foreign origin can never proceed.
    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    if (method === 'POST' && !checkMutation(req.headers).ok)
      return sendJson(res, 403, { error: 'forbidden' });
    const url = new URL(req.url ?? '/', 'http://devbar.invalid');
    if (url.pathname.startsWith('/api/'))
      return routeApi(req, res, url, method);
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    serveStatic(res, url);
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((failure: unknown) => {
      console.error('[remote] request failed:', failure);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  };

  return {
    start: async () => {
      if (server) return;
      error = null;
      const candidate = (deps.createHttpServer ?? http.createServer)(onRequest);
      candidate.requestTimeout = REQUEST_TIMEOUT_MS;
      candidate.headersTimeout = HEADERS_TIMEOUT_MS;
      server = candidate;
      await new Promise<void>((resolve) => {
        candidate.once('listening', () => {
          listening = true;
          resolve();
        });
        candidate.on('error', (failure) => {
          // Once listening, an error (EMFILE on accept…) is logged and the
          // server keeps going; only a failed listen is reported to the UI.
          if (listening) {
            console.error('[remote] server error:', failure);
            return;
          }
          error = listenError(failure, deps.port);
          server = null;
          resolve();
        });
        candidate.listen(deps.port, deps.listenHost ?? '0.0.0.0');
      });
      deps.onStateChange();
    },
    stop: async () => {
      const current = server;
      if (!current) return;
      server = null;
      listening = false;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections();
      });
      deps.onStateChange();
    },
    listening: () => listening,
    error: () => error,
    port: boundPort,
  };
}
