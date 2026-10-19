import { iconButton } from '../icon.js';
import { latestWins } from '../latest-wins.js';
import { stripAnsi } from '../logs/ansi.js';
import { formatClock, formatPreciseDuration } from './list-model.js';
import { runScripts } from '../pipeline/run-view.js';
import { pipelineRefKey } from '../../src/pipeline-graph.js';
import type {
  LogEntry,
  Pipeline,
  PreStepScriptRef,
} from '../../src/domain-types.js';
import type {
  WorkflowRunState,
  WorkflowScriptRunState,
} from '../../src/ipc-contract.js';
import { spinPhase } from '../spin-phase.js';

/**
 * The log drawer at the bottom of the canvas: one tab per script of the
 * workflow's latest run, the selected script's output (refreshed every second
 * while it runs, and whenever the run moves on), «exit N · 3.2s», a way out
 * to the logs window, and a close button. It sticks to the bottom unless the
 * user scrolled up to read.
 */

export interface LogDrawerDeps {
  host: HTMLElement;
  workflowId: () => string | null;
  run: () => WorkflowRunState | null;
  pipeline: () => Pipeline;
  nameOf: (ref: PreStepScriptRef) => string;
  now: () => number;
  pollMs?: number;
  /** The drawer opened or closed (the legend makes room for it). */
  onToggle?: (open: boolean) => void;
}

export interface LogDrawer {
  element: HTMLElement;
  /** Opens on `refKey`, or on the run's first script. */
  open(refKey?: string | null): void;
  close(): void;
  isOpen(): boolean;
  /** The run changed: repaint the tabs and refetch what may have grown. */
  update(): void;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function levelOf(entry: LogEntry, text: string): 'error' | 'warn' | null {
  if (entry.level) return entry.level;
  if (/\berror\b/i.test(text)) return 'error';
  if (/\bwarn(ing)?\b/i.test(text)) return 'warn';
  return null;
}

function lineOf(entry: LogEntry): HTMLElement {
  const text = stripAnsi(entry.line);
  const level = levelOf(entry, text);
  const line = el('div', 'wf-log-line');
  if (level) line.classList.add(`is-${level}`);
  if (entry.stream === 'sys') line.classList.add('is-sys');
  line.append(el('span', 'wf-log-time', `[${clock(entry.ts)}] `), text);
  return line;
}

function mark(status: string): HTMLElement {
  return status === 'running'
    ? spinPhase(el('span', 'pipeline-spinner'))
    : el('span', `wf-dot is-${status}`);
}

export function createLogDrawer(deps: LogDrawerDeps): LogDrawer {
  const element = el('section', 'wf-log');
  element.setAttribute('aria-label', 'Log');
  element.hidden = true;
  const head = el('div', 'wf-log-head');
  const tabs = el('div', 'wf-log-tabs');
  tabs.setAttribute('role', 'tablist');
  const meta = el('span', 'wf-log-meta');
  const external = iconButton(
    'external-link',
    'Abrir en la ventana de logs',
    'wf-log-btn',
  );
  const closer = iconButton('x', 'Cerrar log', 'wf-log-btn');
  head.append(tabs, el('span', 'wf-spacer'), meta, external, closer);
  const body = el('div', 'wf-log-body');
  body.setAttribute('role', 'log');
  body.tabIndex = 0;
  element.append(head, body);
  deps.host.append(element);

  let selected: string | null = null;
  let stick = true;
  let shownStatus: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reads = latestWins();

  const scripts = (): WorkflowScriptRunState[] =>
    runScripts(deps.run(), deps.pipeline());
  const selectedScript = (): WorkflowScriptRunState | null =>
    scripts().find((s) => pipelineRefKey(s) === selected) ?? null;

  function stopPolling(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function fetchLog(): Promise<void> {
    stopPolling();
    const script = selectedScript();
    const id = deps.workflowId();
    if (!script || !id) {
      body.replaceChildren();
      return;
    }
    reads.invalidate();
    const current = reads.claim();
    const ref = { groupId: script.groupId, scriptId: script.scriptId };
    let entries: LogEntry[] | null = null;
    try {
      entries = await window.api.getWorkflowScriptLog(id, 'latest', ref);
    } catch {
      entries = null;
    }
    if (!current() || element.hidden) return;
    body.replaceChildren(...(entries ?? []).map(lineOf));
    if (stick) body.scrollTop = body.scrollHeight;
    if (selectedScript()?.status === 'running')
      timer = setTimeout(() => void fetchLog(), deps.pollMs ?? 1000);
  }

  function paintMeta(script: WorkflowScriptRunState | null): void {
    if (!script || script.startedAt === null) {
      meta.textContent = '';
      return;
    }
    if (script.status === 'running') {
      meta.textContent = formatClock(deps.now() - script.startedAt);
      return;
    }
    const took =
      script.finishedAt === null
        ? ''
        : formatPreciseDuration(script.finishedAt - script.startedAt);
    meta.textContent = [
      script.exitCode === null ? '' : `exit ${script.exitCode}`,
      took,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function paintTabs(): void {
    const list = scripts();
    if (!list.some((s) => pipelineRefKey(s) === selected))
      selected = list[0] ? pipelineRefKey(list[0]) : null;
    tabs.replaceChildren(
      ...list.map((script) => {
        const key = pipelineRefKey(script);
        const tab = el('button', `wf-log-tab is-${script.status}`);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.dataset.ref = key;
        tab.setAttribute('aria-selected', String(key === selected));
        tab.append(mark(script.status), el('span', '', deps.nameOf(script)));
        return tab;
      }),
    );
    const script = selectedScript();
    element.setAttribute(
      'aria-label',
      script ? `Log de ${deps.nameOf(script)}` : 'Log',
    );
    paintMeta(script);
  }

  function select(key: string | null): void {
    selected = key;
    stick = true;
    paintTabs();
    shownStatus = selectedScript()?.status ?? null;
    void fetchLog();
  }

  tabs.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '.wf-log-tab',
    );
    if (tab?.dataset.ref) select(tab.dataset.ref);
  });
  body.addEventListener('scroll', () => {
    stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  });
  external.addEventListener('click', () => {
    const id = deps.workflowId();
    const script = selectedScript();
    if (id)
      void window.api.openWorkflowLog(
        id,
        script ? { groupId: script.groupId, scriptId: script.scriptId } : null,
      );
  });

  function close(): void {
    if (element.hidden) return;
    stopPolling();
    reads.invalidate();
    element.hidden = true;
    deps.onToggle?.(false);
  }
  closer.addEventListener('click', close);

  return {
    element,
    open: (key) => {
      const wasHidden = element.hidden;
      element.hidden = false;
      select(key ?? null);
      if (wasHidden) deps.onToggle?.(true);
    },
    close,
    isOpen: () => !element.hidden,
    update: () => {
      if (element.hidden) return;
      paintTabs();
      const status = selectedScript()?.status ?? null;
      // A script that just started or finished has new output to show; one
      // still running is already being polled.
      if (status !== shownStatus) {
        shownStatus = status;
        void fetchLog();
      }
    },
  };
}
