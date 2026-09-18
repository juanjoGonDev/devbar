/**
 * Loads a renderer window (its HTML plus its entry module) inside jsdom, with
 * a `window.api` the test drives by hand.
 *
 * The point is ORDERING. Every read (`getGroupStates`, `listLogs`, …) returns
 * a promise the test resolves when it chooses, and every `on…` subscription
 * hands its callback back, so a test can fire a push from the main process and
 * only THEN resolve a read that was issued earlier — the interleaving that
 * makes a stale write overwrite a newer one.
 *
 * This file lives under `tests/helpers/` because vitest collects
 * `tests/**\/*.test.ts`; a helper here is a module, not a suite.
 */
/// <reference lib="dom" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const rendererDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../renderer',
);

type Listener = (...args: never[]) => unknown;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface RendererWindowOptions {
  /** File name of the window's markup inside `renderer/`, e.g. `tray.html`. */
  html: string;
  /**
   * Imports the window's entry module. Kept as a callback so the specifier
   * stays static in the test file and vite can resolve it.
   */
  load: () => Promise<unknown>;
  /** Non-callable members of `window.api`, e.g. `platform`. */
  values?: Readonly<Record<string, unknown>>;
}

export interface RendererWindow {
  /** How many times the renderer has called `name`. */
  callCount(name: string): number;
  /** Answers the oldest unanswered call of `name` and drains what it wakes. */
  settle(name: string, value: unknown): Promise<void>;
  /**
   * Answers the NEWEST unanswered call of `name`. Two reads in flight at once
   * is the whole scenario: this lets the later one come back first, leaving
   * the earlier one to resolve against state it no longer owns.
   */
  settleNewest(name: string, value: unknown): Promise<void>;
  /** Fails the oldest unanswered call of `name` and drains what it wakes. */
  fail(name: string, error: unknown): Promise<void>;
  /** Delivers a push to every callback registered through `name`. */
  push(name: string, ...args: unknown[]): Promise<void>;
  /** Stops the tickers the module installed while loading. */
  close(): void;
}

/** Lets every queued `then`/`await` the last action woke actually run. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `onUpdate` subscribes; `getGroupStates` reads. Everything else reads too. */
function isSubscription(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

export async function loadRendererWindow(
  options: RendererWindowOptions,
): Promise<RendererWindow> {
  document.documentElement.innerHTML = fs.readFileSync(
    path.join(rendererDir, options.html),
    'utf8',
  );

  // jsdom has no matchMedia, and `renderer/theme.ts` calls it at import time.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });

  const pending = new Map<string, PendingCall[]>();
  const listeners = new Map<string, Listener[]>();
  const counts = new Map<string, number>();
  const members = new Map<string, unknown>();
  const intervals: ReturnType<typeof setInterval>[] = [];

  const values = options.values ?? {};
  const memberFor = (name: string): unknown => {
    if (Object.hasOwn(values, name)) return values[name];
    const cached = members.get(name);
    if (cached !== undefined) return cached;
    const member: unknown = isSubscription(name)
      ? (listener: Listener) => {
          const registered = listeners.get(name) ?? [];
          registered.push(listener);
          listeners.set(name, registered);
        }
      : () => {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          return new Promise<unknown>((resolve, reject) => {
            const queue = pending.get(name) ?? [];
            queue.push({ resolve, reject });
            pending.set(name, queue);
          });
        };
    members.set(name, member);
    return member;
  };

  const api = new Proxy(
    {},
    {
      get: (_target, property) =>
        typeof property === 'string' ? memberFor(property) : undefined,
      has: (_target, property) => typeof property === 'string',
    },
  );
  Object.defineProperty(window, 'api', { configurable: true, value: api });

  // A renderer entry point installs tickers at load (the uptime clock, the
  // sidebar repaint). Left running they fire mid-assertion and outlive the
  // test, so the harness keeps their handles and closes them itself.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((
    handler: Parameters<typeof setInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = realSetInterval(handler, timeout, ...args);
    intervals.push(id);
    return id;
  }) as typeof setInterval;

  try {
    vi.resetModules();
    await options.load();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  await drain();

  const take = (name: string, newest: boolean): PendingCall => {
    const queue = pending.get(name);
    const call = newest ? queue?.pop() : queue?.shift();
    if (!call) throw new Error(`no pending call to settle: ${name}`);
    return call;
  };

  return {
    callCount: (name) => counts.get(name) ?? 0,
    settle: async (name, value) => {
      take(name, false).resolve(value);
      await drain();
    },
    settleNewest: async (name, value) => {
      take(name, true).resolve(value);
      await drain();
    },
    fail: async (name, error) => {
      take(name, false).reject(error);
      await drain();
    },
    push: async (name, ...args) => {
      for (const listener of listeners.get(name) ?? [])
        (listener as (...rest: unknown[]) => unknown)(...args);
      await drain();
    },
    close: () => {
      for (const id of intervals) clearInterval(id);
      intervals.length = 0;
    },
  };
}
