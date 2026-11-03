/**
 * The command link: how a stored `link` is normalised, which detected port is
 * the primary one, and which URL «abrir» resolves to. All pure, so the rules
 * the tray, the editor and `openPort` share are tested once.
 */
import { isPrivateIPv4 } from '../net/private-ipv4.js';
import type { CommandLink, DetectedPort } from '../domain-types.js';

const DEFAULT_LINK: CommandLink = { mode: 'auto' };

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Any stored shape → a valid link. A missing or unknown mode is `auto`; a
 * custom link without an http(s) URL falls back to `auto` rather than
 * leaving a link that can never open.
 */
export function normalizeCommandLink(value: unknown): CommandLink {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_LINK };
  const raw = value as Record<string, unknown>;
  if (raw.mode === 'none') return { mode: 'none' };
  if (raw.mode === 'custom') {
    const url = cleanString(raw.url);
    return parseHttpUrl(url) ? { mode: 'custom', url } : { ...DEFAULT_LINK };
  }
  const path = cleanString(raw.path);
  return path ? { mode: 'auto', path } : { ...DEFAULT_LINK };
}

/** This machine (loopback, `*.localhost`, its hostname) or a private LAN address. */
export function isLocalHttpUrl(
  value: string,
  machineHostname: string | null = null,
): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const own = machineHostname?.toLowerCase() ?? null;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    isPrivateIPv4(host) ||
    (own !== null && (host === own || host === `${own}.local`))
  );
}

/**
 * Primary first: a web port the log announced, then the lowest web port, then
 * the HTTP APIs and everything else by port number.
 */
export function sortPorts(ports: readonly DetectedPort[]): DetectedPort[] {
  const rank = (port: DetectedPort): number =>
    port.kind === 'web'
      ? port.source === 'log'
        ? 0
        : 1
      : port.kind === 'http'
        ? 2
        : 3;
  return [...ports].sort((a, b) => rank(a) - rank(b) || a.port - b.port);
}

function withPath(base: string, path: string | undefined): string {
  if (!path) return base;
  const url = new URL(base);
  return new URL(
    path.startsWith('/') ? path : `/${path}`,
    url.origin,
  ).toString();
}

export type OpenTarget =
  { ok: true; url: string } | { ok: false; error: string };

/**
 * The URL «abrir» goes to. A specific `port` opens that detected port; else
 * the link decides: `custom` its URL, `auto` the primary web port plus its
 * optional path, `none` nothing.
 */
export function resolveOpenUrl(
  link: CommandLink | undefined,
  ports: readonly DetectedPort[],
  port?: number,
): OpenTarget {
  if (port !== undefined) {
    const found = ports.find((candidate) => candidate.port === port);
    return found
      ? { ok: true, url: found.url }
      : { ok: false, error: `El puerto ${port} no está abierto` };
  }
  const resolved = normalizeCommandLink(link);
  if (resolved.mode === 'none')
    return { ok: false, error: 'Este comando no tiene enlace' };
  if (resolved.mode === 'custom' && resolved.url)
    return { ok: true, url: resolved.url };
  const primary = sortPorts(ports).find(
    (candidate) => candidate.kind === 'web',
  );
  return primary
    ? { ok: true, url: withPath(primary.url, resolved.path) }
    : { ok: false, error: 'No se ha detectado ninguna página web' };
}
