/**
 * Port classification: is what listens on a port a web page, an HTTP API, or
 * not HTTP at all (Postgres on 5432, Redis on 6379)? One `GET /` with a short
 * timeout answers it, following at most a few redirects that stay on this
 * machine. The verdict is cached per (process, port) until that process
 * restarts, so a long-running service is probed once per port, not per scan.
 *
 * The request itself is injected (`HttpGet`): tests never open a socket.
 */
import http from 'node:http';
import https from 'node:https';

export type PortKind = 'web' | 'http' | 'other';

export interface ProbeResponse {
  status: number;
  contentType: string | null;
  location: string | null;
}

/** The answer to one GET, or null when nothing HTTP answered in time. */
export type HttpGet = (
  url: string,
  timeoutMs: number,
) => Promise<ProbeResponse | null>;

const PROBE_TIMEOUT_MS = 800;
const MAX_REDIRECTS = 3;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** TLS refusals that still prove an HTTPS server answered the handshake. */
const UNTRUSTED_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * What a failed GET still tells us. A dev server's certificate is usually
 * self-signed: rather than turn certificate checks off, an untrusted one is
 * read as what it proves — an HTTPS server is there — and offered as a page;
 * the browser makes its own call when the user opens it. Anything else
 * (refused, reset, not TLS) means nothing HTTP answered.
 */
export function responseForError(error: unknown): ProbeResponse | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UNTRUSTED_CERT_CODES.has(code)
    ? { status: 0, contentType: 'text/html', location: null }
    : null;
}

/**
 * The production GET: headers only (the body is never read), certificates
 * checked as usual, and every failure — refused, timed out, not HTTP — folded
 * into null except an untrusted certificate (see `responseForError`).
 */
const nodeHttpGet: HttpGet = (url, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value: ProbeResponse | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const client = url.startsWith('https:') ? https : http;
      const request = client.get(
        url,
        {
          timeout: timeoutMs,
          headers: { accept: 'text/html,*/*;q=0.8' },
        },
        (response) => {
          done({
            status: response.statusCode ?? 0,
            contentType: response.headers['content-type'] ?? null,
            location: response.headers.location ?? null,
          });
          response.destroy();
        },
      );
      request.on('timeout', () => request.destroy());
      request.on('error', (error) => done(responseForError(error)));
      request.on('close', () => done(null));
    } catch {
      done(null);
    }
  });

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** A redirect target that stays on this machine, or null. */
function localRedirect(from: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const next = new URL(location, from);
    const local =
      (next.protocol === 'http:' || next.protocol === 'https:') &&
      LOCAL_HOSTS.has(next.hostname);
    return local ? next.toString() : null;
  } catch {
    return null;
  }
}

export function classifyResponse(response: ProbeResponse | null): PortKind {
  if (!response) return 'other';
  if (/html/i.test(response.contentType ?? '')) return 'web';
  // A redirect browsers would follow but the probe may not (off-machine, or
  // past the hop budget) is still somewhere to send the user.
  return isRedirect(response.status) ? 'web' : 'http';
}

export async function probePort(
  url: string,
  get: HttpGet = nodeHttpGet,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<PortKind> {
  let current = url;
  let response = await get(current, timeoutMs);
  for (let hop = 0; hop < MAX_REDIRECTS && response; hop++) {
    if (!isRedirect(response.status)) break;
    const next = localRedirect(current, response.location);
    if (!next) break;
    current = next;
    response = (await get(current, timeoutMs)) ?? response;
  }
  return classifyResponse(response);
}

/**
 * Per-process verdict cache. `kind` dedupes concurrent asks for the same port
 * (one probe in flight, every caller awaits it); `forget` drops a process's
 * verdicts when it restarts or stops.
 */
export interface PortClassifier {
  kind: (processId: string, port: number, url: string) => Promise<PortKind>;
  /** The verdict already known, without probing. */
  known: (processId: string, port: number) => PortKind | null;
  forget: (processId: string) => void;
}

export function createPortClassifier(
  probe: (url: string) => Promise<PortKind> = (url) => probePort(url),
): PortClassifier {
  const pending = new Map<string, Map<number, Promise<PortKind>>>();
  const settled = new Map<string, Map<number, PortKind>>();
  return {
    kind(processId, port, url) {
      const byPort =
        pending.get(processId) ?? new Map<number, Promise<PortKind>>();
      pending.set(processId, byPort);
      const existing = byPort.get(port);
      if (existing) return existing;
      const verdict = probe(url).then(
        (kind) => kind,
        () => 'other' as const,
      );
      byPort.set(port, verdict);
      void verdict.then((kind) => {
        // A restart in between forgot this process: do not resurrect it.
        if (pending.get(processId) !== byPort) return;
        const known = settled.get(processId) ?? new Map<number, PortKind>();
        known.set(port, kind);
        settled.set(processId, known);
      });
      return verdict;
    },
    known: (processId, port) => settled.get(processId)?.get(port) ?? null,
    forget(processId) {
      pending.delete(processId);
      settled.delete(processId);
    },
  };
}
