import { icon, iconButton } from '../icon.js';
import {
  lastRunText,
  scheduleSummary,
  scriptsLine,
  workflowStatus,
} from './list-model.js';
import { TRIGGER_META } from './trigger-meta.js';
import type { Group } from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';
import { spinPhase } from '../spin-phase.js';

/**
 * One row of the Workflows list. A builder only: the buttons carry
 * `data-action` and the row its `data-id`, and the list handles every click
 * and key through delegation.
 */

export interface RowInput {
  entry: WorkflowEntry;
  groups: readonly Group[];
  now: number;
  /** The row being renamed in place, with what has been typed so far. */
  renaming: string | null;
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

function cell(className: string): HTMLDivElement {
  const node = el('div', `wf-cell ${className}`);
  node.setAttribute('role', 'cell');
  return node;
}

function nameCell(input: RowInput): HTMLElement {
  const { workflow } = input.entry;
  const kind = workflow.trigger.kind;
  const box = cell('wf-cell-name');
  const tile = el('span', `wf-tile is-${kind}`);
  tile.append(icon(TRIGGER_META[kind].icon));
  if (kind === 'startup') {
    tile.setAttribute('role', 'img');
    tile.setAttribute('aria-label', 'Workflow de arranque');
  }
  const text = el('div', 'wf-name-wrap');
  if (input.renaming !== null) {
    const field = el('input', 'wf-rename');
    field.value = input.renaming;
    field.setAttribute('aria-label', 'Nombre del workflow');
    text.append(field);
  } else {
    text.append(el('div', 'wf-name', workflow.name));
  }
  const sub = el('div', 'wf-sub', scriptsLine(workflow, input.groups));
  // Drawn always, shown only by the layout that hides the last-run column.
  const { lastRun } = input.entry;
  if (lastRun)
    sub.append(
      el('span', 'wf-sub-last', ` · ${lastRunText(lastRun, input.now)}`),
    );
  text.append(sub);
  box.append(tile, text);
  return box;
}

function triggerCell(input: RowInput): HTMLElement {
  const { trigger } = input.entry.workflow;
  const box = cell('wf-cell-trigger');
  const pill = el('span', `wf-pill is-${trigger.kind}`);
  if (trigger.kind === 'startup') pill.append(icon('zap'));
  pill.append(el('span', '', TRIGGER_META[trigger.kind].pill));
  box.append(pill);
  if (trigger.kind === 'schedule')
    box.append(
      el('span', 'wf-sub wf-trigger-sub', scheduleSummary(trigger.schedule)),
    );
  return box;
}

function statusCell(input: RowInput): HTMLElement {
  const box = cell('wf-cell-status');
  const status = workflowStatus(input.entry);
  const pill = el('span', `wf-status is-${status.kind}`);
  const dot = el('span', 'wf-dot');
  // The running dot pulses; phase-locked so a repaint does not restart it.
  if (status.kind === 'running') spinPhase(dot);
  pill.append(dot, el('span', '', status.label));
  box.append(pill);
  return box;
}

function actionButton(
  action: string,
  name: Parameters<typeof iconButton>[0],
  label: string,
): HTMLButtonElement {
  const button = iconButton(name, label, `wf-icon-btn is-${action}`);
  button.dataset.action = action;
  return button;
}

/** Shown on hover — always while the workflow is hidden. */
function eyeButton(hidden: boolean): HTMLButtonElement {
  const eye = actionButton(
    'eye',
    hidden ? 'eye-off' : 'eye',
    hidden
      ? 'Mostrar en la barra y el móvil'
      : 'Ocultar en la barra y el móvil',
  );
  eye.classList.add('wf-eye');
  return eye;
}

function actionsCell(input: RowInput): HTMLElement {
  const { entry } = input;
  const box = cell('wf-cell-actions');
  box.append(eyeButton(entry.workflow.hidden));
  if (entry.running) box.append(actionButton('stop', 'square', 'Detener'));
  else if (entry.workflow.enabled) {
    const run = actionButton('run', 'play', 'Ejecutar ahora');
    if (entry.scriptCount === 0) {
      // aria-disabled, not disabled: the tooltip has to say why.
      run.setAttribute('aria-disabled', 'true');
      run.title = 'Sin scripts conectados';
    }
    box.append(run);
  }
  const toggle = el('input', 'remote-switch wf-switch');
  toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch');
  toggle.checked = entry.workflow.enabled;
  toggle.dataset.action = 'enable';
  toggle.setAttribute('aria-label', 'Activo');
  const more = actionButton('menu', 'ellipsis', 'Más acciones');
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  box.append(toggle, more);
  return box;
}

export function buildRow(input: RowInput): HTMLElement {
  const { workflow } = input.entry;
  const row = el('div', 'wf-row');
  row.dataset.id = workflow.id;
  row.setAttribute('role', 'row');
  row.tabIndex = 0;
  row.setAttribute('aria-label', workflow.name);
  if (workflow.trigger.kind === 'startup') row.classList.add('is-startup');
  if (!workflow.enabled && !input.entry.running) row.classList.add('is-off');
  if (workflow.hidden) row.classList.add('is-hidden');
  const last = cell('wf-cell-last');
  last.append(
    el('span', 'wf-sub wf-last', lastRunText(input.entry.lastRun, input.now)),
  );
  row.append(
    nameCell(input),
    triggerCell(input),
    last,
    statusCell(input),
    actionsCell(input),
  );
  return row;
}

export function headRow(): HTMLElement {
  const row = el('div', 'wf-row wf-head');
  row.setAttribute('role', 'row');
  for (const [text, extra] of [
    ['Nombre', ''],
    ['Desencadenante', ''],
    ['Última ejecución', ' wf-cell-last'],
    ['Estado', ''],
    ['Activo', ' is-end'],
  ] as const) {
    const head = el('span', `wf-cell${extra}`, text);
    head.setAttribute('role', 'columnheader');
    row.append(head);
  }
  return row;
}
