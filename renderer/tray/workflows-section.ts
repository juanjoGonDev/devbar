import { formatUptime } from '../format-uptime.js';
import { icon, type IconName } from '../icon.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';
import { showToast } from './host.js';
import { manageLink } from './manage-link.js';
import { workflowSubtitle } from './workflow-format.js';
import { trayWorkflowLayout } from '../../src/tray-layout.js';

/**
 * The popover's Workflows tab: the running (or the startup) workflow first —
 * lightning, progress and a stop button — then the manual and scheduled ones,
 * each with a ▶, then the hidden ones behind an «N oculto(s)» fold when the
 * settings ask for it. «Gestionar workflows», heading the list, opens the
 * settings on the Workflows section.
 *
 * One persistent element: `tray.ts` puts it in the list while the Workflows
 * tab is selected, and `renderWorkflowsSection` repaints it whenever the list
 * changes. `workflowsSummary` tells the tabs whether there is anything to
 * list and how many are running.
 *
 * Every state push (many a second while something runs) repaints the list,
 * so a row is rebuilt only when what it shows changed, and an unchanged one
 * never leaves the DOM: detaching the element under the pointer makes macOS
 * drop the hand cursor back to an arrow.
 */

const section = document.createElement('section');
section.id = 'tray-workflows';
section.className = 'tray-workflows';

/** The element `tray.ts` shows on the Workflows tab. */
export function workflowsSection(): HTMLElement {
  return section;
}

function kindIcon(entry: WorkflowEntry): IconName {
  switch (entry.workflow.trigger.kind) {
    case 'startup':
      return 'zap';
    case 'schedule':
      return 'calendar-clock';
    case 'manual':
      return 'workflow';
  }
}

function actionButton(
  label: string,
  name: IconName,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost icon-only tray-wf-action';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(icon(name));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/**
 * Opens the latest run's narration — the one in flight while it runs. Off,
 * with the reason as its tooltip, while no run this session left a log.
 */
function logButton(entry: WorkflowEntry): HTMLButtonElement {
  const { workflow } = entry;
  const btn = actionButton(
    `Ver el log de «${workflow.name}»`,
    'scroll-text',
    () => {
      if (entry.hasLog) void window.api.openWorkflowLog(workflow.id);
    },
  );
  if (!entry.hasLog) {
    // aria-disabled, not disabled: the tooltip has to say why.
    btn.setAttribute('aria-disabled', 'true');
    btn.title = 'Todavía no se ha ejecutado';
  }
  return btn;
}

/** Half a script past the settled ones, like the old strip: never 0 or 100. */
function progressPercent(done: number, total: number): number {
  const safeTotal = Math.max(1, total);
  const settled = Math.min(Math.max(0, done), safeTotal);
  return Math.min(100, ((settled + 0.5) / safeTotal) * 100);
}

async function run(entry: WorkflowEntry): Promise<void> {
  const res = await window.api.runWorkflow(entry.workflow.id);
  if (res && !res.ok && res.error === 'already_running')
    showToast(`«${entry.workflow.name}» ya está en marcha`, 'warn');
}

function row(entry: WorkflowEntry, now: number): HTMLElement {
  const { workflow, running } = entry;
  const el = document.createElement('div');
  el.className = 'tray-wf-row';
  el.dataset.workflowId = workflow.id;
  const mark = icon(kindIcon(entry));
  mark.classList.add('tray-wf-icon');
  const text = document.createElement('span');
  text.className = 'tray-wf-text';
  const name = document.createElement('span');
  name.className = 'tray-wf-name';
  name.textContent = workflow.name;
  text.append(name);
  if (running) {
    el.classList.add('is-running');
    const line = document.createElement('span');
    line.className = 'tray-wf-sub';
    const count = document.createElement('span');
    count.className = 'tray-wf-count';
    count.textContent = `${running.doneScripts}/${running.totalScripts}`;
    count.title = `${running.doneScripts} de ${running.totalScripts} scripts terminados`;
    const elapsed = document.createElement('span');
    elapsed.className = 'uptime';
    elapsed.dataset.startedAt = String(running.startedAt);
    elapsed.textContent = formatUptime(now - running.startedAt);
    line.append(count, elapsed);
    const bar = document.createElement('span');
    bar.className = 'tray-wf-progress';
    const fill = document.createElement('span');
    fill.className = 'tray-wf-progress-bar';
    fill.style.width = `${progressPercent(running.doneScripts, running.totalScripts)}%`;
    bar.append(fill);
    text.append(line, bar);
    el.append(
      mark,
      text,
      logButton(entry),
      actionButton(`Detener «${workflow.name}»`, 'square', () => {
        void window.api.stopWorkflow(workflow.id);
      }),
    );
    return el;
  }
  const sub = document.createElement('span');
  sub.className = 'tray-wf-sub';
  sub.textContent = workflowSubtitle(entry, now);
  text.append(sub);
  if (entry.lastRun?.result === 'error') el.classList.add('is-failed');
  el.append(
    mark,
    text,
    logButton(entry),
    actionButton(`Ejecutar «${workflow.name}»`, 'play', () => void run(entry)),
  );
  return el;
}

interface BuiltRow {
  key: string;
  el: HTMLElement;
}
/** Each listed row, with what it was built from; `next` fills during a repaint. */
let built = new Map<string, BuiltRow>();
let next = new Map<string, BuiltRow>();

/**
 * The row for `entry`: the one already listed while nothing it shows changed
 * (a running row's clock ticks on its own, see `tray.ts`), else a new one.
 */
function rowFor(
  entry: WorkflowEntry,
  now: number,
  hidden: boolean,
): HTMLElement {
  const key = JSON.stringify([
    entry,
    entry.running ? null : workflowSubtitle(entry, now),
    hidden,
  ]);
  const id = entry.workflow.id;
  const previous = built.get(id);
  let el = previous?.key === key ? previous.el : undefined;
  if (!el) {
    el = row(entry, now);
    if (hidden) el.classList.add('is-hidden-group');
  }
  next.set(id, { key, el });
  return el;
}

/** Puts `nodes` in `section`, moving or removing only what changed. */
function reconcile(nodes: readonly Element[]): void {
  const keep = new Set(nodes);
  for (const child of Array.from(section.children))
    if (!keep.has(child)) child.remove();
  nodes.forEach((node, i) => {
    const at = section.children[i];
    if (at !== node) section.insertBefore(node, at ?? null);
  });
}

const manage = manageLink('Gestionar workflows', 'workflows');
let lastEntries: readonly WorkflowEntry[] = [];
/** Settings › General › «Mostrar workflows ocultos plegados». */
let showFold = false;
let foldOpen = false;

let fold: { key: string; el: HTMLButtonElement } | null = null;

/** The «N oculto(s)» toggle, kept while its count and state hold. */
function foldToggle(count: number): HTMLButtonElement {
  const key = `${count}:${foldOpen}`;
  if (fold?.key === key) return fold.el;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost hidden-groups-toggle';
  btn.setAttribute('aria-expanded', String(foldOpen));
  btn.append(
    icon(foldOpen ? 'chevron-down' : 'chevron-right'),
    ` ${count} ${count === 1 ? 'oculto' : 'ocultos'}`,
  );
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    foldOpen = !foldOpen;
    renderWorkflowsSection(lastEntries);
  });
  fold = { key, el: btn };
  return btn;
}

/** Follows the setting; repaints (and says so) only when it changed. */
export function setWorkflowsFold(on: boolean): boolean {
  if (on === showFold) return false;
  showFold = on;
  renderWorkflowsSection(lastEntries);
  return true;
}

let summary = { listed: 0, running: 0 };

/** Workflows listed (in sight or behind the fold), and those running. */
export function workflowsSummary(): { listed: number; running: number } {
  return summary;
}

export function renderWorkflowsSection(
  entries: readonly WorkflowEntry[],
): void {
  lastEntries = entries;
  const { shown, folded } = trayWorkflowLayout(entries, showFold);
  summary = {
    listed: shown.length + folded.length,
    running: shown.filter((entry) => entry.running !== null).length,
  };
  const now = Date.now();
  next = new Map();
  const nodes: HTMLElement[] = [manage];
  nodes.push(...shown.map((entry) => rowFor(entry, now, false)));
  if (folded.length > 0) {
    nodes.push(foldToggle(folded.length));
    if (foldOpen)
      nodes.push(...folded.map((entry) => rowFor(entry, now, true)));
  }
  built = next;
  reconcile(nodes);
}
