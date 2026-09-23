/**
 * Mounts the logs window's markup and hands its panes a `window.api` the test
 * drives — WITHOUT loading the entry point.
 *
 * `tests/helpers/renderer-dom.ts` loads a whole window; this is the smaller
 * tool for the modules underneath it. `renderer/logs/elements.ts` resolves
 * every node it binds AT IMPORT TIME, so a pane can only be imported once the
 * markup is in the document — and it has to be re-imported whenever the markup
 * is replaced, or it keeps writing into nodes nobody can see. So this mounts
 * `logs.html`, resets the module registry, and leaves the `await import(...)`
 * to the test, which is also what keeps each pane's module-level state (the
 * buffer, the load queue, the sidebar signature) fresh per test.
 *
 * This file lives under `tests/helpers/` because vitest collects
 * `tests/**\/*.test.ts`; a helper here is a module, not a suite.
 */
/// <reference lib="dom" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { LogEntry } from '../../src/domain-types.js';

const rendererDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../renderer',
);

type Listener = (...args: never[]) => unknown;

interface ApiCall {
  name: string;
  args: unknown[];
}

export interface LogsDom {
  /** Every `window.api` call the panes made, in order. */
  calls: ApiCall[];
  /** The argument lists of every call to `name`, oldest first. */
  argsFor(name: string): readonly unknown[][];
  /** Delivers a push to every callback registered through `on…`. */
  push(name: string, ...args: unknown[]): void;
}

export interface MountLogsOptions {
  /** The window's own query string, e.g. `'?detached=1'`. */
  search?: string;
  /**
   * What the `window.api` members the test cares about answer. Anything not
   * listed still exists and still records its call; it just returns
   * `undefined`, which is all a pane that fires and forgets needs.
   */
  api?: Readonly<Record<string, (...args: never[]) => unknown>>;
}

/** Rows `flashEntry` centred, in order, so a test can assert the jump landed. */
export const scrolledIntoView: Element[] = [];

/**
 * jsdom ships no `scrollIntoView`, and the log pane centres the row it jumped
 * to. Recording the call is also the only observable the jump has: a
 * layout-less document has nowhere to scroll to.
 */
function stubScrollIntoView(): void {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: function scrollIntoView(this: Element) {
      scrolledIntoView.push(this);
    },
  });
}

/**
 * jsdom has no `CSS` object at all, and both the drawer and the sidebar look
 * rows up by an id they escape with `CSS.escape` (`g1:web` is a real id, and
 * `:` starts a pseudo-class). This is the CSSOM serialization algorithm, so
 * the selectors under test are the ones the real renderer builds.
 */
function escapeIdentifier(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const char = value.charAt(i);
    if (code === 0) {
      out += '�';
    } else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)
    ) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && code === 0x2d && value.length === 1) {
      out += `\\${char}`;
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      out += char;
    } else {
      out += `\\${char}`;
    }
  }
  return out;
}

/**
 * Listeners the panes put on `document` and `window` — the two nodes mounting
 * fresh markup does NOT replace.
 *
 * `selection-ui.ts` binds its shortcuts to `document` and `pane.ts` binds
 * `resize` to `window`, both at import time. Re-importing a pane for the next
 * test therefore stacks a second copy on top of the first, and the stale one
 * keeps answering — writing into a detached DOM, but still reaching the
 * clipboard and the module state the new copy owns. So they are recorded and
 * detached before the next mount.
 */
interface Recorded {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options: boolean | AddEventListenerOptions | undefined;
}

let recorded: Recorded[] = [];
let recording = false;

function recordGlobalListeners(): void {
  for (const { target, type, listener, options } of recorded)
    target.removeEventListener(type, listener, options);
  recorded = [];
  if (recording) return;
  recording = true;
  for (const target of [document, window] as EventTarget[]) {
    const original = target.addEventListener.bind(target);
    Object.defineProperty(target, 'addEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        recorded.push({ target, type, listener, options });
        original(type, listener, options);
      },
    });
  }
}

function stubCssEscape(): void {
  const existing = (globalThis as { CSS?: { escape?: unknown } }).CSS;
  if (existing && typeof existing.escape === 'function') return;
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { ...(existing ?? {}), escape: escapeIdentifier },
  });
}

/**
 * Fill in what jsdom does not implement, and detach the `document`/`window`
 * listeners the previous mount left behind.
 *
 * Call this BEFORE importing (or re-importing) anything under `renderer/`:
 * both halves have to be in place before the module-level wiring runs.
 */
export function installJsdomGaps(): void {
  scrolledIntoView.length = 0;
  recordGlobalListeners();
  stubScrollIntoView();
  stubCssEscape();
}

/**
 * Mount `logs.html`, install a recording `window.api`, and clear the module
 * registry. Import the panes under test AFTER calling this.
 */
export function mountLogsDom(options: MountLogsOptions = {}): LogsDom {
  document.documentElement.innerHTML = fs.readFileSync(
    path.join(rendererDir, 'logs.html'),
    'utf8',
  );
  // `logs/params.ts` reads `location.search` once, at import.
  window.history.replaceState({}, '', options.search || '/');
  localStorage.clear();
  installJsdomGaps();

  // `renderer/theme.ts` calls matchMedia at import time. Only the entry point
  // pulls it in, but a pane test that grows into one should not have to learn
  // that the hard way.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });

  const calls: ApiCall[] = [];
  const listeners = new Map<string, Listener[]>();
  const members = new Map<string, unknown>();
  const impls = options.api ?? {};

  const memberFor = (name: string): unknown => {
    const cached = members.get(name);
    if (cached !== undefined) return cached;
    const member: unknown = /^on[A-Z]/.test(name)
      ? (listener: Listener) => {
          const registered = listeners.get(name) ?? [];
          registered.push(listener);
          listeners.set(name, registered);
        }
      : (...args: unknown[]) => {
          calls.push({ name, args });
          const impl = impls[name];
          return impl
            ? (impl as (...rest: unknown[]) => unknown)(...args)
            : undefined;
        };
    members.set(name, member);
    return member;
  };

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(
      {},
      {
        get: (_target, property) =>
          typeof property === 'string' ? memberFor(property) : undefined,
        has: (_target, property) => typeof property === 'string',
      },
    ),
  });

  vi.resetModules();

  return {
    calls,
    argsFor: (name) =>
      calls.filter((call) => call.name === name).map((call) => call.args),
    push: (name, ...args) => {
      for (const listener of listeners.get(name) ?? [])
        (listener as (...rest: unknown[]) => unknown)(...args);
    },
  };
}

/** A log line, with only the fields a given test cares about spelled out. */
export function entry(line: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line, ...extra };
}

/** Lets the promises the last action woke actually run. */
export async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
