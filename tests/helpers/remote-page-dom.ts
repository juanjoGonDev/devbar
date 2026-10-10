import fs from 'node:fs';
import path from 'node:path';
import type { RemoteStateView } from '../../src/ipc-contract/remote-wire.js';

/**
 * The phone page's fixtures (a clock, `me` answers, a state with two groups,
 * a pending confirmation) and the DOM helpers its tests read the page with.
 * The fake DevBar they run against is tests/helpers/remote-page.ts.
 */

const RENDERER = path.join(import.meta.dirname, '..', '..', 'renderer');

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
