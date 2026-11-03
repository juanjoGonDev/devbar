/**
 * Log-based port detection: the local URLs a dev server announces in its own
 * output («Local: http://localhost:5173/», «listening on port 3000», …).
 *
 * Pure and total — a line is a string in, a list out — so every phrasing is a
 * table row in tests/ports-log-urls.test.ts. Only hosts that are THIS machine
 * count (loopback, the any-address, its hostname, its LAN addresses): a log
 * line about a remote database or a registry must never become a link.
 */
import { stripAnsi } from '../process/log-filters.js';

export interface LogPortHit {
  port: number;
  /** As announced, with the any-address (0.0.0.0, [::]) read as localhost. */
  url: string;
}

/** This machine's names besides loopback; empty when unknown. */
export interface LocalHostNames {
  hostname: string | null;
  lanAddresses: readonly string[];
}

const NO_HOSTS: LocalHostNames = { hostname: null, lanAddresses: [] };

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const ANY_ADDRESS = ['0.0.0.0', '[::]', '::'];

const URL_RE =
  /\b(https?):\/\/(\[[0-9a-f:]*\]|[a-z0-9.-]+):(\d{1,5})(\/[^\s'"<>`)\],]*)?/gi;
/** «listening on port 3000», «Tomcat started on port(s): 8080», «… 0.0.0.0 port 8000». */
const PORT_WORD_RE =
  /\b(?:listen(?:ing)?|running|started|serving|server)\b.*?\bport(?:\(s\))?:?\s+(\d{1,5})\b/i;
/** «Listening on :3000», «started server on 0.0.0.0:3000». */
const HOST_PORT_RE =
  /\b(?:listen(?:ing)?|running|started|serving)\b.*?\b(?:on|at)\s+(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])?:(\d{1,5})\b/i;

const LABELS: ReadonlyArray<[RegExp, string]> = [
  [/\bstorybook\b/i, 'Storybook'],
  [/\bvite\b/i, 'Vite'],
  [/\bnext\.js\b/i, 'Next.js'],
  [/\bwebpack\b/i, 'webpack'],
  [/\bnest(?:application|\])/i, 'Nest'],
  [/\bdjango\b/i, 'Django'],
  [/\bspring boot\b/i, 'Spring Boot'],
  [/\b(?:puma|rails)\b/i, 'Rails'],
  [/\bastro\b/i, 'Astro'],
  [/\bangular\b/i, 'Angular'],
];

function validPort(raw: string | undefined): number | null {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function localHost(host: string, names: LocalHostNames): string | null {
  const value = host.toLowerCase();
  if (ANY_ADDRESS.includes(value)) return 'localhost';
  if (LOOPBACK.includes(value)) return value;
  if (names.hostname && value === names.hostname.toLowerCase()) return value;
  return names.lanAddresses.includes(value) ? value : null;
}

/** A sentence's full stop or a closing mark is not part of the path. */
function trimPath(path: string | undefined): string {
  return (path ?? '').replace(/[.;:!?]+$/, '');
}

function urlHits(line: string, names: LocalHostNames): LogPortHit[] {
  const hits: LogPortHit[] = [];
  for (const match of line.matchAll(URL_RE)) {
    const [, scheme = 'http', host = '', rawPort, path] = match;
    const port = validPort(rawPort);
    const name = localHost(host, names);
    if (port === null || name === null) continue;
    hits.push({
      port,
      url: `${scheme.toLowerCase()}://${name}:${port}${trimPath(path)}`,
    });
  }
  return hits;
}

function phraseHit(line: string): LogPortHit | null {
  const hostPort = HOST_PORT_RE.exec(line);
  const raw = hostPort ? hostPort[2] : PORT_WORD_RE.exec(line)?.[1];
  const port = validPort(raw);
  return port === null ? null : { port, url: `http://localhost:${port}` };
}

/**
 * Every local URL `line` announces, one per port (the first mention wins, so
 * an explicit URL beats the bare phrase around it).
 */
export function extractLogPorts(
  line: string,
  names: LocalHostNames = NO_HOSTS,
): LogPortHit[] {
  const clean = stripAnsi(line);
  const hits = urlHits(clean, names);
  if (hits.length === 0) {
    const phrase = phraseHit(clean);
    if (phrase) hits.push(phrase);
  }
  const seen = new Set<number>();
  return hits.filter((hit) => !seen.has(hit.port) && seen.add(hit.port));
}

/** The dev tool a line names («VITE v5 ready», «Storybook 7 started»), if any. */
export function detectLabel(line: string): string | null {
  const clean = stripAnsi(line);
  return LABELS.find(([pattern]) => pattern.test(clean))?.[1] ?? null;
}
