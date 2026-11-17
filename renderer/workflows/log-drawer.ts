import { iconButton } from '../icon.js';
import { createLogView } from '../log-view/log-view.js';
import { formatClock, formatPreciseDuration } from './list-model.js';
import { runScripts } from '../pipeline/run-view.js';
import { pipelineRefKey } from '../../src/pipeline-graph.js';
import { makePreScriptId } from '../../src/compound-id.js';
import type { Pipeline, PreStepScriptRef } from '../../src/domain-types.js';
import type {
  WorkflowRunState,
  WorkflowScriptRunState,
} from '../../src/ipc-contract.js';
import { spinPhase } from '../spin-phase.js';

/**
 * The log drawer at the bottom of the canvas: one tab per script of the
 * workflow's latest run, the selected script's output, «exit N · 3.2s», a
 * way out to the logs window, and a close button.
 *
 * The output is the logs window's own view of that script — the same engine
 * (`renderer/log-view/`) over the same buffer (`pre:<group>:<script>` in
 * main), fed the same way: a `logs:get` snapshot, then the `logs:line`
 * pushes, live. So it reads exactly as the logs window does: colours,
 * JSON, folded stack traces, progress bars redrawn in place, following the
 * tail unless the reader scrolled up. Only the tabs, the meta and the
 * buttons are the drawer's own.
 */

export interface LogDrawerDeps {
  host: HTMLElement;
  workflowId: () => string | null;
  run: () => WorkflowRunState | null;
  pipeline: () => Pipeline;
  nameOf: (ref: PreStepScriptRef) => string;
  now: () => number;
  /** The drawer opened or closed (the legend makes room for it). */
  onToggle?: (open: boolean) => void;
}

export interface LogDrawer {
  element: HTMLElement;
  /** Opens on `refKey`, or on the run's first script. */
  open(refKey?: string | null): void;
  close(): void;
  isOpen(): boolean;
  /** The run changed: repaint the tabs, and follow a script that (re)started. */
  update(): void;
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

function mark(status: string): HTMLElement {
  return status === 'running'
    ? spinPhase(el('span', 'pipeline-spinner'))
    : el('span', `wf-dot is-${status}`);
}

/**
 * Whether the script ran in this run. One that did not — still waiting,
 * skipped, cancelled before its turn, or turned away (no path, declined,
 * already running) — has nothing in its buffer but the previous run's
 * output, under which a refusal only appended its reason.
 */
function reachedThisRun(script: WorkflowScriptRunState): boolean {
  return script.startedAt !== null;
}

/** What the drawer says instead of a log the script does not have yet. */
function pendingText(script: WorkflowScriptRunState): string {
  if (script.status === 'waiting') return 'Todavía no ha empezado';
  const text = 'No ha llegado a ejecutarse';
  return script.reason ? `${text} · ${script.reason}` : text;
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
  const lines = el('div', 'wf-log-lines');
  const empty = el('div', 'wf-log-empty');
  empty.hidden = true;
  body.append(lines, empty);
  element.append(head, body);
  deps.host.append(element);

  const view = createLogView({ lines, main: body, scrollButton: null });
  window.api.onLog((payload) => view.receivePush(payload));

  let selected: string | null = null;
  /** The process, and the run of it, the view was last pointed at. */
  let shown: { processId: string; startedAt: number | null } | null = null;

  const scripts = (): WorkflowScriptRunState[] =>
    runScripts(deps.run(), deps.pipeline());
  const selectedScript = (): WorkflowScriptRunState | null =>
    scripts().find((s) => pipelineRefKey(s) === selected) ?? null;

  /** Nothing to show: the view lets go of what it was showing. */
  function showNothing(text: string | null): void {
    shown = null;
    view.clear();
    empty.textContent = text ?? '';
    empty.hidden = text === null;
  }

  /**
   * Point the view at the selected script's buffer — once per run of it: a
   * new run (a retry, the next run) emptied main's buffer, so it is read
   * again; the same run just keeps streaming.
   */
  function follow(): void {
    const script = selectedScript();
    if (!script) return showNothing(null);
    if (!reachedThisRun(script)) return showNothing(pendingText(script));
    const processId = makePreScriptId(script.groupId, script.scriptId);
    if (shown?.processId === processId && shown.startedAt === script.startedAt)
      return;
    shown = { processId, startedAt: script.startedAt };
    empty.hidden = true;
    void view.open(processId);
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
    paintTabs();
    follow();
  }

  tabs.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '.wf-log-tab',
    );
    if (tab?.dataset.ref) select(tab.dataset.ref);
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
    showNothing(null);
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
      follow();
    },
  };
}
