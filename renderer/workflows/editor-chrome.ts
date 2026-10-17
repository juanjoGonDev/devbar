import { icon, iconButton } from '../icon.js';
import { formatAgo, formatDuration } from './list-model.js';
import { TRIGGER_META } from './trigger-meta.js';
import type { Workflow, WorkflowRunResult } from '../../src/domain-types.js';
import type {
  WorkflowEntry,
  WorkflowRunState,
} from '../../src/ipc-contract.js';

/**
 * The editor's floating chrome (the WorkflowRun mock): the breadcrumb pill
 * top left — «Workflows › name › trigger» plus the panel toggle —, the run
 * status pill top right, and the status legend bottom left while a run is
 * on the canvas. Built once; `paint` refreshes it from the latest state.
 */

export interface EditorChromeDeps {
  onBack: () => void;
  onRename: (name: string) => void;
  onTogglePanel: () => void;
  onRun: () => void;
  onStop: () => void;
}

interface ChromeState {
  workflow: Workflow | null;
  entry: WorkflowEntry | null;
  run: WorkflowRunState | null;
  /** `3 scripts`: what the idle pill says. */
  summary: string;
  panelOpen: boolean;
  now: number;
}

export interface EditorChrome {
  breadcrumb: HTMLElement;
  status: HTMLElement;
  legend: HTMLElement;
  paint(state: ChromeState): void;
  /** Focuses the name, all of it selected, ready to be typed over. */
  focusName(): void;
}

const RESULT_LABEL: Record<WorkflowRunResult, string> = {
  success: 'Correcto',
  warning: 'Con avisos',
  error: 'Error',
  cancelled: 'Cancelado',
};

const LEGEND: ReadonlyArray<[string, string]> = [
  ['waiting', 'En espera'],
  ['running', 'Ejecutando'],
  ['success', 'Correcto'],
  ['warning', 'Con avisos'],
  ['error', 'Error'],
  ['skipped', 'Omitido'],
];

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

function textButton(
  className: string,
  name: Parameters<typeof icon>[0],
  label: string,
): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.append(icon(name), el('span', '', label));
  return button;
}

/** The last run worth reporting: this session's, or the persisted one. */
function finishedRun(
  state: ChromeState,
): { result: WorkflowRunResult; finishedAt: number } | null {
  const { run, entry } = state;
  if (run && run.status !== 'running')
    return { result: run.status, finishedAt: run.finishedAt ?? state.now };
  return entry?.lastRun ?? null;
}

export function createEditorChrome(deps: EditorChromeDeps): EditorChrome {
  const breadcrumb = el('nav', 'wf-crumb');
  breadcrumb.setAttribute('aria-label', 'Ruta');
  const back = el('button', 'wf-crumb-back', 'Workflows');
  back.type = 'button';
  const chevron = icon('chevron-right');
  chevron.classList.add('wf-crumb-sep');
  const name = el('input', 'wf-crumb-name');
  name.setAttribute('aria-label', 'Nombre del workflow');
  name.spellcheck = false;
  const pill = el('span', 'wf-pill');
  const toggle = iconButton('panel-left', 'Pre-scripts', 'wf-crumb-panel');
  breadcrumb.append(back, chevron, name, pill, toggle);

  const status = el('div', 'pipeline-status wf-run-status');
  status.setAttribute('role', 'status');
  const legend = el('div', 'wf-legend');
  legend.setAttribute('aria-label', 'Leyenda');
  for (const [kind, label] of LEGEND) {
    const item = el('span', 'wf-legend-item');
    item.append(el('span', `wf-legend-mark is-${kind}`), el('span', '', label));
    legend.append(item);
  }

  let stored = '';
  const sizeName = (): void => {
    name.size = Math.max(4, name.value.length + 1);
  };
  const commit = (): void => {
    const next = name.value.trim();
    if (!next || next === stored) {
      name.value = stored;
      sizeName();
      return;
    }
    stored = next;
    deps.onRename(next);
  };
  name.addEventListener('input', sizeName);
  name.addEventListener('change', commit);
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') name.blur();
    else if (event.key === 'Escape') {
      event.stopPropagation();
      name.value = stored;
      sizeName();
      name.blur();
    }
  });
  name.addEventListener('blur', commit);
  back.addEventListener('click', () => deps.onBack());
  toggle.addEventListener('click', () => deps.onTogglePanel());
  status.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest('button');
    if (!target || target.getAttribute('aria-disabled') === 'true') return;
    if (target.classList.contains('wf-stop')) deps.onStop();
    else if (target.classList.contains('wf-run-btn')) deps.onRun();
  });

  function paintCrumb(state: ChromeState): void {
    const workflow = state.workflow;
    if (document.activeElement !== name) {
      stored = workflow?.name ?? '';
      name.value = stored;
      sizeName();
    }
    const kind = workflow?.trigger.kind ?? 'manual';
    pill.className = `wf-pill is-${kind}`;
    pill.replaceChildren(
      icon(TRIGGER_META[kind].icon),
      el('span', '', TRIGGER_META[kind].pill),
    );
    pill.hidden = workflow === null;
    toggle.setAttribute('aria-pressed', String(state.panelOpen));
  }

  function runButton(state: ChromeState, withText: boolean): HTMLElement {
    const button = withText
      ? textButton('wf-run-btn', 'play', 'Ejecutar')
      : iconButton('play', 'Ejecutar', 'wf-run-btn is-icon');
    if (state.entry?.scriptCount === 0) {
      button.setAttribute('aria-disabled', 'true');
      button.title = 'Sin scripts conectados';
    }
    return button;
  }

  function paintStatus(state: ChromeState): void {
    const { run } = state;
    if (run?.status === 'running') {
      status.replaceChildren(
        el('span', 'pipeline-spinner'),
        el(
          'span',
          'wf-run-label is-running',
          `Ejecutando · ${run.doneScripts}/${run.totalScripts}`,
        ),
        el('span', 'wf-run-time', formatDuration(state.now - run.startedAt)),
        textButton('wf-stop', 'square', 'Detener'),
      );
      return;
    }
    const finished = finishedRun(state);
    if (finished) {
      status.replaceChildren(
        el('span', `wf-dot is-${finished.result}`),
        el('span', 'wf-run-label', RESULT_LABEL[finished.result]),
        el('span', 'wf-run-time', formatAgo(finished.finishedAt, state.now)),
        runButton(state, false),
      );
      return;
    }
    status.replaceChildren(
      el('span', 'wf-run-count', state.summary),
      runButton(state, true),
    );
  }

  return {
    breadcrumb,
    status,
    legend,
    paint: (state) => {
      paintCrumb(state);
      paintStatus(state);
      legend.hidden = state.run === null;
    },
    focusName: () => {
      name.focus();
      name.select();
    },
  };
}
