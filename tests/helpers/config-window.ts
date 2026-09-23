/**
 * Opens the config window under jsdom and builds the fixtures its panes read.
 *
 * `tests/helpers/renderer-dom.ts` owns the harness itself (markup + entry
 * module + a hand-driven `window.api`); this adds the one entry point every
 * `tests/config-*.test.ts` file needs plus the domain fixtures, so no test has
 * to restate the full shape of a group.
 */
import { loadRendererWindow, type RendererWindow } from './renderer-dom.js';
import type {
  Action,
  Command,
  Group,
  PreScript,
} from '../../src/domain-types.js';
import type { UpdateStatus } from '../../src/ipc-contract.js';

/**
 * jsdom ships `<dialog>` with its `open` property but none of its methods, and
 * the config window opens its command editor with `showModal()`. Install the
 * two the window uses, keeping `open` as the single source of truth so a test
 * can read it back.
 */
function stubDialogMethods(): void {
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

/** Lets queued promises the last action woke actually run. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Waits for something the window reaches on its own schedule — a dynamically
 * imported panel mounting, say — instead of guessing a number of ticks.
 */
export async function waitFor(
  predicate: () => boolean,
  attempts = 300,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('the window never reached the expected state');
}

export async function openConfigWindow(
  platform = 'macos',
): Promise<RendererWindow> {
  stubDialogMethods();
  return loadRendererWindow({
    html: 'config.html',
    load: () => import('../../renderer/config.js'),
    values: { platform },
  });
}

/**
 * Three modules read `getSettings` while the window boots, in this order:
 * `theme.ts`, the settings pane, then the pipeline editor. Answering the two
 * bystanders leaves exactly the pane's own read for a test to settle or fail.
 */
export async function answerBystanderSettingsReads(
  win: RendererWindow,
): Promise<void> {
  await win.settle('getSettings', {}); // renderer/theme.ts
  await win.settleNewest('getSettings', {}); // renderer/pipeline-editor.ts
}

/**
 * Records the arguments the window passes to one `window.api` method.
 *
 * The harness's own proxy counts calls but keeps their arguments to itself,
 * and what a save actually WRITES is the whole point of some of these tests.
 * Call this after the window has loaded: the renderer reads `window.api.x`
 * afresh on every call, so wrapping the object afterwards still catches it.
 */
export function recordApiCalls(name: string): unknown[][] {
  const recorded: unknown[][] = [];
  const underlying = window.api as unknown as Record<string, unknown>;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(
      {},
      {
        get: (_target, property) => {
          const member = underlying[property as string];
          if (property !== name || typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            recorded.push(args);
            return (member as (...rest: unknown[]) => unknown)(...args);
          };
        },
        has: () => true,
      },
    ),
  });
  return recorded;
}

/**
 * Reorders a row through the KEYBOARD path (grab, move, drop).
 *
 * The pointer path needs `DragEvent`, which jsdom has not got, so every one of
 * these lists is reorderable in a test only this way — and both paths end in
 * the very same `onReorder` callback.
 */
export function keyboardReorder(
  row: HTMLElement,
  direction: 'up' | 'down',
): void {
  const handle = row.querySelector<HTMLElement>('.drag-handle');
  if (!handle) throw new Error('that row has no drag handle');
  for (const key of [
    ' ',
    direction === 'up' ? 'ArrowUp' : 'ArrowDown',
    'Enter',
  ])
    handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

export function group(name: string, extra: Partial<Group> = {}): Group {
  return {
    id: `group-${name}`,
    name,
    icon: '📦',
    path: `/tmp/${name}`,
    mode: 'single',
    order: 0,
    silenceWarnings: false,
    silenceErrors: false,
    env: [],
    commands: [],
    actions: [],
    preScripts: [],
    waitForPipeline: true,
    ...extra,
  };
}

export function command(name: string, extra: Partial<Command> = {}): Command {
  return {
    id: `cmd-${name}`,
    name,
    icon: '⚙️',
    command: 'npm',
    args: ['run', name],
    env: [],
    cwd: null,
    warnRegex: '',
    errorRegex: '',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
    autoStart: false,
    schedule: { enabled: false, rules: [] },
    maxLogLines: null,
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    ...extra,
  };
}

export function action(name: string, extra: Partial<Action> = {}): Action {
  return {
    id: `act-${name}`,
    name,
    icon: '🪄',
    command: 'make',
    args: [name],
    env: [],
    inheritGroupEnv: false,
    schedule: { enabled: false, rules: [] },
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    ...extra,
  };
}

export function preScript(
  name: string,
  extra: Partial<PreScript> = {},
): PreScript {
  return {
    id: `pre-${name}`,
    name,
    command: 'docker',
    args: ['up'],
    env: [],
    inheritGroupEnv: true,
    timeoutMs: null,
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    ...extra,
  };
}

export function updateStatus(version: string | null): UpdateStatus {
  return {
    available: version
      ? {
          version,
          url: `https://example.invalid/${version}`,
          dmgUrl: null,
          zipUrl: null,
          setupUrl: null,
          appImageUrl: null,
          debUrl: null,
        }
      : null,
    staged: null,
    lastCheckAt: null,
    currentVersion: '0.0.0',
  };
}
