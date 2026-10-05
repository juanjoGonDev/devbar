import type { IncomingHttpHeaders } from 'node:http';

/**
 * The HTTP-level rules of the remote-control server, kept apart from the
 * routing so each can be checked on its own.
 *
 * The transport is plain HTTP on the LAN (no certificate a phone would trust
 * exists for a LAN address); what crosses it is sealed by devbar-rc/1
 * (src/main/remote/secure-api.ts). On top of that the browser's own
 * protections still apply: a mutation shape (JSON + a custom header + a
 * matching Origin) that a page on another origin cannot produce without a
 * CORS preflight — which this server never answers. No cookie is ever set:
 * a session is a handshake, named by the `X-DevBar-Session` header.
 */

const MAX_BODY_BYTES = 16 * 1024;
/** A 16-byte session id in base64url is exactly 22 characters. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** Sent on every response, whatever it is. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/** The page's policy; frame-ancestors only works as a header. */
export const HTML_CSP =
  "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

/** The session id of the `X-DevBar-Session` header, when well-formed. */
export function readSessionId(
  header: string | string[] | undefined,
): string | null {
  return typeof header === 'string' && SESSION_ID_SHAPE.test(header)
    ? header
    : null;
}

export type Verdict = { ok: true } | { ok: false; status: number };

/**
 * Every non-GET request: a JSON body, the DevBar header and, when the
 * browser says where it comes from, our own origin.
 */
export function checkMutation(headers: IncomingHttpHeaders): Verdict {
  const forbidden = { ok: false, status: 403 } as const;
  const mediaType = (headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/json') return forbidden;
  if (headers['x-devbar-request'] !== '1') return forbidden;
  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://${headers.host ?? ''}`)
    return forbidden;
  return { ok: true };
}

export type BodyResult =
  { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/** Reads at most 16 KB of JSON; 413 past that, 400 when it does not parse. */
export async function readJsonBody(
  body: AsyncIterable<Buffer | string>,
  declaredLength: string | undefined,
): Promise<BodyResult> {
  if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES)
    return { ok: false, status: 413 };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413 };
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400 };
  }
}
