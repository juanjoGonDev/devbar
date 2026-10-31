/// <reference lib="dom" />
/**
 * Fixtures and a harness for the pipeline editor's window tests: it mounts
 * the editor on config.html's host with a hand-driven `window.api`, and
 * drives it with the pointer, key and drag events a person would.
 */
import { afterEach, beforeEach, vi } from 'vitest';

import { loadRendererWindow, type RendererWindow } from './renderer-dom.js';
import {
  initPipelineEditor,
  type PipelineEditorDeps,
  type PipelineEditorHandle,
} from '../../renderer/pipeline-editor.js';
import { normalizeGroup } from '../../src/groups-model.js';
import type {
  Group,
  Pipeline,
  PipelineBlock,
  PreStepScriptRef,
  Workflow,
} from '../../src/domain-types.js';
import { startupEntries, startupWorkflow } from './startup-workflow.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

export function ref(groupId: string, scriptId: string): PreStepScriptRef {
  return { groupId, scriptId };
}

export const SETUP = ref('back', 'setup');
export const SEED = ref('back', 'seed');
export const DEPS = ref('front', 'deps');

export function blk(
  id: string,
  scripts: PreStepScriptRef[],
  x: number,
  y: number,
): PipelineBlock {
  return { id, scripts, x, y, requireAll: true };
}

export function graph(blocks: PipelineBlock[], edges: string[]): Pipeline {
  return {
    blocks,
    edges: edges.map((edge) => {
      const [from = '', to = ''] = edge.split('>');
      return { from, to };
    }),
  };
}

/** Back: Make setup, Seed — Front: Install deps. */
export function groups(): Group[] {
  return [
    normalizeGroup({
      id: 'back',
      name: 'Back',
      icon: 'server',
      iconColor: '#3b82f6',
      path: '/repos/back',
      preScripts: [
        { id: 'setup', name: 'Make setup', command: 'make', args: ['setup'] },
        { id: 'seed', name: 'Seed', command: 'pnpm', timeoutMs: 90_000 },
      ],
    }),
    normalizeGroup({
      id: 'front',
      name: 'Front',
      path: '/repos/front',
      preScripts: [{ id: 'deps', name: 'Install deps', command: 'pnpm i' }],
    }),
  ];
}

/** Trigger → setup (300,40) → deps (600,40). */
export function chain(): Pipeline {
  return graph(
    [blk('a', [SETUP], 300, 40), blk('b', [DEPS], 600, 40)],
    ['trigger>a', 'a>b'],
  );
}

export function pipelineHost(): HTMLElement {
  const el = document.getElementById('prescripts-pipeline-root');
  if (!el) throw new Error('config.html has no pipeline host');
  // The Workflows section shows the list first and the editor on demand.
  el.hidden = false;
  return el;
}

export function query<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

export function all(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

export function node(name: string): HTMLElement {
  const found = all('.pipeline-node').find(
    (candidate) =>
      candidate.querySelector('.pipeline-node-name')?.textContent === name,
  );
  if (!found) throw new Error(`the canvas draws no "${name}" node`);
  return found;
}

export function blockEl(id: string): HTMLElement {
  return query(`.pipeline-block[data-block="${id}"]`);
}

export function chip(name: string): HTMLElement {
  const found = all('.pipeline-chip').find(
    (candidate) =>
      candidate.querySelector('.pipeline-chip-name')?.textContent === name,
  );
  if (!found) throw new Error(`the panel lists no "${name}"`);
  return found;
}

/** Text without the icon glyphs (private-use codepoints). */
export function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/[\uE000-\uF8FF]/g, '').trim();
}

export function button(
  label: string,
  scope = '#prescripts-pipeline-root',
): HTMLElement {
  const found = all(`${scope} button, ${scope} [role="button"]`).find(
    (candidate) =>
      candidate.getAttribute('aria-label') === label ||
      textOf(candidate) === label,
  );
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

export function canvas(): HTMLElement {
  return query('.pipeline-canvas');
}

function world(): HTMLElement {
  return query('.pipeline-world');
}

export function zoomText(): string {
  return query('.pipeline-zoom-value').textContent ?? '';
}

export function click(target: Element): void {
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
}

export function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

export function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  buttonIndex = 0,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: buttonIndex,
      clientX: x,
      clientY: y,
    }),
  );
}

/** A pointer drag from `source` at (x0, y0) to (x1, y1). Untransformed and
 * unmeasured, the canvas maps client pixels 1:1 onto world pixels. */
export function dragPointer(
  source: Element,
  from: [number, number],
  to: [number, number],
  buttonIndex = 0,
): void {
  pointer(source, 'pointerdown', from[0], from[1], buttonIndex);
  pointer(window, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  pointer(window, 'pointermove', to[0], to[1]);
  pointer(window, 'pointerup', to[0], to[1]);
}

/** A native drag of a panel chip, dropped on `target` at (x, y). */
export function dropChip(source: Element, target: Element, x = 0, y = 0): void {
  const fire = (on: Element, type: string): void => {
    on.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    );
  };
  fire(source, 'dragstart');
  fire(target, 'dragover');
  fire(target, 'drop');
  fire(source, 'dragend');
}

export function transform(): string {
  return world().style.transform;
}

export type Toasts = Array<{ message: string; kind?: string | undefined }>;

export function edgesOf(pipeline: Pipeline): string[] {
  return pipeline.edges.map((edge) => `${edge.from}>${edge.to}`);
}

/** Lets queued writes and the (zero-delay) move debounce run. */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Registers the per-test setup and teardown (call it inside the file's
 * top-level describe) and returns the ways to open an editor.
 */
export function editorHarness() {
  let editorWindow: RendererWindow | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    editorWindow?.close();
    editorWindow = null;
    vi.restoreAllMocks();
  });

  async function openEditor(
    options: {
      groups?: Group[];
      editScript?: PipelineEditorDeps['editScript'];
      createScript?: PipelineEditorDeps['createScript'];
      /** What the section's list holds (for the popover and the pill). */
      entries?: () => WorkflowEntry[];
      onBack?: () => void;
      now?: () => number;
    } = {},
  ): Promise<{
    win: RendererWindow;
    editor: PipelineEditorHandle;
    toasts: Toasts;
  }> {
    const win = await loadRendererWindow({
      html: 'config.html',
      // The editor is a factory the config window mounts, not an entry point
      // of its own, so there is nothing to evaluate on load.
      load: () => Promise.resolve(),
      values: { platform: 'macos' },
    });
    editorWindow = win;
    const toasts: Toasts = [];
    const known = options.groups ?? [];
    const editor = initPipelineEditor(pipelineHost(), {
      getGroups: () => known,
      showToast: (message, kind) => toasts.push({ message, kind }),
      moveDebounceMs: 0,
      ...(options.editScript ? { editScript: options.editScript } : {}),
      ...(options.createScript ? { createScript: options.createScript } : {}),
      ...(options.entries ? { getEntries: options.entries } : {}),
      ...(options.onBack ? { onBack: options.onBack } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    return { win, editor, toasts };
  }

  /** Opens the editor and lands `pipeline` as the first read. */
  async function openWith(
    pipeline: Pipeline,
    options: Omit<Parameters<typeof openEditor>[0] & object, 'groups'> & {
      groups?: Group[];
    } = {},
  ): Promise<{
    win: RendererWindow;
    editor: PipelineEditorHandle;
    toasts: Toasts;
  }> {
    const opened = await openEditor({ groups: groups(), ...options });
    void opened.editor.refresh();
    await opened.win.settle('listWorkflows', startupEntries(pipeline));
    return opened;
  }

  /** The last pipeline the editor wrote; main answers with it unchanged. */
  async function written(win: RendererWindow): Promise<Pipeline> {
    await tick(); // writes queue behind the one in flight
    const calls = win.argsFor('saveWorkflow');
    const pipeline = (calls.at(-1)?.[0] as Workflow | undefined)?.graph;
    if (!pipeline) throw new Error('nothing was written');
    await win.settle('saveWorkflow', startupWorkflow(pipeline));
    return pipeline;
  }

  /** Closes `win` after the test, like the windows the harness opens. */
  function adopt(win: RendererWindow): void {
    editorWindow = win;
  }

  return { openEditor, openWith, written, adopt };
}
