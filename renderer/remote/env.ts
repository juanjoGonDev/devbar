import type { Fetcher } from './channel.js';
import type { EventSourceLike } from './connection.js';

/**
 * The browser, as the phone page uses it. renderer/remote.ts hands in the
 * real globals; every test hands in fakes, so each flow — pairing, the live
 * stream, countdowns, read marks — can be driven by hand.
 */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RemoteEnv {
  fetch: Fetcher;
  /** `location.pathname`: `/`, `/pair` or `/verify`. */
  pathname: string;
  /** `location.search`. */
  search: string;
  /**
   * `location.hash`: where a QR puts what must never cross the network (an
   * identity key, a device's keys). Read once, then cleared from the URL.
   */
  hash: string;
  /** `location.hostname`: the address this page was served from. */
  hostname: string;
  /** `history.replaceState` — drops a spent code or a fragment from the URL. */
  replaceUrl(url: string): void;
  confirm(message: string): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
  openEvents(url: string): EventSourceLike;
  /** `localStorage`; may throw (private mode, blocked site data). */
  storage(): StorageLike;
  reload(): void;
}
