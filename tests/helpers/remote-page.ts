import fs from 'node:fs';
import path from 'node:path';
import { startRemoteApp, type RemoteEnv } from '../../renderer/remote/app.js';
import type { EventSourceLike } from '../../renderer/remote/connection.js';
import type { RemoteStateView } from '../../src/ipc-contract/remote-wire.js';

/**
 * The phone page (renderer/remote.html + renderer/remote/*) driven against
 * fakes of everything the browser provides: `fetch` answered by route, an
 * EventSource the test emits on, timers and intervals run by hand, a
 * localStorage map and a fixed clock.
 */

const RENDERER = path.join(import.meta.dirname, '..', '..', 'renderer');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = { status: number; body: unknown } | Error;

export interface FakeSource extends EventSourceLike {
  url: string;
  closed: boolean;
  /** Dispatches an event; objects are sent as their JSON. */
  emit(type: string, data?: unknown): void;
}

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

/** 1 Oct 2026, 10:12:40 local time. */
export const NOW = new Date(2026, 9, 1, 10, 12, 40).getTime();
const MINUTE = 60_000;

export const UNLINKED = {
  status: 200,
  body: {
    linked: false,
    host: { name: 'Mac-de-Ana' },
    suggestedName: 'iPhone',
  },
};
export const LINKED = {
  status: 200,
  body: {
    linked: true,
    device: {
      id: 'd1',
      name: 'iPhone de Ana',
      createdAt: NOW - 19 * 86_400_000,
    },
    host: { name: 'Mac-de-Ana', version: '0.11.0' },
  },
};

export function state(extra: Partial<RemoteStateView> = {}): RemoteStateView {
  return {
    now: NOW,
    host: { name: 'Mac-de-Ana', version: '0.11.0' },
    groups: [
      {
        id: 'g1',
        name: 'Backend',
        color: 'warn',
        branch: 'main',
        lastError: null,
        commands: [
          {
            id: 'api',
            processId: 'cmd:g1:api',
            name: 'API',
            status: 'running',
            color: 'warn',
            warnCount: 2,
            errorCount: 0,
            lastError: null,
            startedAt: NOW - 72 * MINUTE,
          },
          {
            id: 'jobs',
            processId: 'cmd:g1:jobs',
            name: 'Cola de jobs',
            status: 'stopped',
            color: 'stopped',
            warnCount: 0,
            errorCount: 0,
            lastError: null,
            startedAt: null,
          },
        ],
        actions: [
          {
            id: 'seed',
            processId: 'act:g1:seed',
            name: 'Seed de datos',
            status: 'idle',
            lastExitCode: null,
            startedAt: null,
          },
        ],
      },
      {
        id: 'g2',
        name: 'Docs',
        color: 'error',
        branch: null,
        lastError: null,
        commands: [
          {
            id: 'astro',
            processId: 'cmd:g2:astro',
            name: 'Astro dev',
            status: 'error',
            color: 'error',
            warnCount: 0,
            errorCount: 1,
            lastError: 'exit 1',
            startedAt: null,
          },
        ],
        actions: [],
      },
    ],
    pipeline: {
      status: 'idle',
      currentStep: null,
      totalSteps: 2,
      lastError: null,
    },
    update: { currentVersion: '0.11.0', state: 'current', version: null },
    confirms: [],
    ...extra,
  };
}

export const CONFIRM = {
  token: 't1',
  name: 'migrate',
  command: 'pnpm db:migrate',
  groupName: 'Backend',
  secs: 42,
  onTimeout: 'cancel' as const,
  deadline: NOW + 42_000,
};

export function loadPage(): void {
  document.documentElement.innerHTML = fs.readFileSync(
    path.join(RENDERER, 'remote.html'),
    'utf8',
  );
  const proto = window.HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  if (typeof proto.showModal !== 'function')
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  if (typeof proto.close !== 'function')
    proto.close = function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

export function pageHarness(
  search = '',
  options: { storage?: Map<string, string> | 'broken' } = {},
) {
  const calls: Call[] = [];
  const answers = new Map<string, Answer[]>();
  /** The last answer of a route keeps answering once its queue runs dry. */
  const sticky = new Map<string, Answer>();
  const timeouts: Timer[] = [];
  const intervals: Timer[] = [];
  const sources: FakeSource[] = [];
  const urls: string[] = [];
  const confirms: string[] = [];
  const storage: Map<string, string> | null =
    options.storage === 'broken'
      ? null
      : (options.storage ?? new Map<string, string>());
  let confirmAnswer = true;
  let reloads = 0;
  let clock = NOW;

  const answer = (route: string, ...replies: Answer[]): void => {
    answers.set(route, [...(answers.get(route) ?? []), ...replies]);
  };
  const env: RemoteEnv = {
    fetch: (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const route = `${method} ${url.split('?')[0]}`;
      const reply = answers.get(route)?.shift() ?? sticky.get(route);
      if (reply) sticky.set(route, reply);
      if (!reply) return Promise.reject(new Error(`no answer for ${route}`));
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        status: reply.status,
        json: () => Promise.resolve(reply.body),
      });
    },
    search,
    hostname: '192.168.1.20',
    replaceUrl: (url) => urls.push(url),
    confirm: (message) => {
      confirms.push(message);
      return confirmAnswer;
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      if (handle) (handle as Timer).cleared = true;
    },
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (handle) => {
      if (handle) (handle as Timer).cleared = true;
    },
    now: () => clock,
    openEvents: (url) => {
      const listeners = new Map<
        string,
        ((event: { data?: unknown }) => void)[]
      >();
      const source: FakeSource = {
        url,
        closed: false,
        addEventListener: (type, listener) =>
          listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        close: () => {
          source.closed = true;
        },
        emit: (type, data) => {
          const payload =
            data === undefined
              ? {}
              : {
                  data: typeof data === 'string' ? data : JSON.stringify(data),
                };
          for (const listener of listeners.get(type) ?? []) listener(payload);
        },
      };
      sources.push(source);
      return source;
    },
    storage: () => {
      if (!storage) throw new Error('SecurityError: storage is disabled');
      return {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
      };
    },
    reload: () => {
      reloads += 1;
    },
  };
  return {
    env,
    calls,
    answer,
    urls,
    confirms,
    sources,
    storage,
    refuseConfirm: () => {
      confirmAnswer = false;
    },
    /** The open (latest) event stream. */
    source: (): FakeSource => {
      const latest = sources.at(-1);
      if (!latest) throw new Error('no event stream was opened');
      return latest;
    },
    /** Runs the next pending one-shot timer and lets its work settle. */
    tick: async () => {
      const timer = timeouts.find((t) => !t.cleared);
      if (!timer) throw new Error('nothing scheduled');
      timer.cleared = true;
      timer.fn();
      await settle();
    },
    /** Runs every live interval once (the page's 1 s clock). */
    beat: () => {
      for (const timer of intervals.filter((t) => !t.cleared)) timer.fn();
    },
    pending: () => timeouts.filter((t) => !t.cleared).length,
    advance: (ms: number) => {
      clock += ms;
    },
    reloads: () => reloads,
    callsTo: (url: string) => calls.filter((call) => call.url === url),
    lastCall: () => calls.at(-1),
  };
}

export type PageHarness = ReturnType<typeof pageHarness>;

export async function start(h: PageHarness): Promise<void> {
  void startRemoteApp(h.env);
  await settle();
}

/** A linked phone with the panel up, its first stream open and live. */
export async function startLinked(
  initial: RemoteStateView = state(),
  options: Parameters<typeof pageHarness>[1] = {},
): Promise<PageHarness> {
  loadPage();
  const h = pageHarness('', options);
  h.answer('GET /api/me', LINKED);
  h.answer('GET /api/state', { status: 200, body: initial });
  h.answer('GET /api/notices', { status: 200, body: { notices: [] } });
  await start(h);
  h.source().emit('open');
  return h;
}

export function visibleView(): string {
  return [...document.querySelectorAll<HTMLElement>('[data-view]')]
    .filter((view) => !view.hidden)
    .map((view) => view.dataset.view)
    .join(',');
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}

export const text = (id: string): string =>
  document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

export function tap(target: Element | null | undefined): void {
  if (!target) throw new Error('nothing to tap');
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

export const tapId = (id: string): void => tap(document.getElementById(id));

/** The visible tab. */
export function visibleTab(): string {
  return [...document.querySelectorAll<HTMLElement>('[data-tab]')]
    .filter((tab) => !tab.hidden)
    .map((tab) => tab.dataset.tab)
    .join(',');
}

export function tabButton(tab: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-tab-button="${tab}"]`,
  );
  if (!button) throw new Error(`no tab button ${tab}`);
  return button;
}

/** The button whose accessible name is exactly `label`. */
export function buttonNamed(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find(
    (button) =>
      (button.getAttribute('aria-label') ??
        button.textContent?.replace(/\s+/g, ' ').trim()) === label,
  );
  if (!found) throw new Error(`no button named "${label}"`);
  return found;
}
