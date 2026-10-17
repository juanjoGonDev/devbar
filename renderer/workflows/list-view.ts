import { icon, iconButton } from '../icon.js';
import { createDeviceMenu } from '../config/remote-device-menu.js';
import {
  filterCounts,
  listWorkflows,
  paginate,
  type WorkflowFilter,
} from './list-model.js';
import { buildRow, headRow } from './list-row.js';
import {
  MANUAL_TRIGGER,
  TRIGGER_META,
  reasonOf,
  runErrorText,
} from './trigger-meta.js';
import type {
  Group,
  Workflow,
  WorkflowTrigger,
} from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

export interface WorkflowListDeps {
  host: HTMLElement;
  getGroups: () => readonly Group[];
  now?: () => number;
  /** Opens a workflow in the editor; `rename` focuses its name. */
  open: (workflowId: string, options?: { rename?: boolean }) => void;
  showToast: (message: string, kind?: string) => void;
}

export interface WorkflowListView {
  /** Repaints the rows from the latest list (search and page are kept). */
  render(entries: readonly WorkflowEntry[]): void;
}

const NEW_NAME = 'Nuevo workflow';

const CHIPS: ReadonlyArray<{ filter: WorkflowFilter; label: string }> = [
  { filter: 'all', label: 'Todos' },
  { filter: 'startup', label: TRIGGER_META.startup.chip },
  { filter: 'schedule', label: TRIGGER_META.schedule.chip },
  { filter: 'manual', label: TRIGGER_META.manual.chip },
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

/** A copy runs only by hand: a second startup workflow is refused. */
function copyTrigger(trigger: WorkflowTrigger): WorkflowTrigger {
  return trigger.kind === 'startup' ? MANUAL_TRIGGER : trigger;
}

/**
 * The Workflows section's list (the WorkflowsList mock): search, filter chips,
 * «Nuevo workflow», one row per workflow with its trigger, last run, status,
 * ▶/■ and the enabled switch, a «⋯» menu (rename, duplicate, delete) and
 * pages of ten. The toolbar is built once so the search keeps its focus; the
 * rows repaint on every list push.
 */
export function createWorkflowList(deps: WorkflowListDeps): WorkflowListView {
  const now = deps.now ?? (() => Date.now());
  let entries: readonly WorkflowEntry[] = [];
  let query = '';
  let filter: WorkflowFilter = 'all';
  let page = 0;
  let renaming: { id: string; value: string } | null = null;
  const menu = createDeviceMenu();

  const root = el('div', 'wf-list');
  const toolbar = el('div', 'wf-toolbar');
  const search = el('label', 'wf-search');
  const field = el('input', '');
  field.type = 'search';
  field.placeholder = 'Buscar workflow…';
  field.setAttribute('aria-label', 'Buscar workflow');
  search.append(icon('search'), field);
  const chips = CHIPS.map(({ filter: value, label }) => {
    const button = el('button', 'wf-chip');
    button.type = 'button';
    button.dataset.filter = value;
    button.dataset.label = label;
    if (value !== 'all') {
      const glyph = icon(TRIGGER_META[value].icon);
      glyph.classList.add(`is-${value}`);
      button.append(glyph);
    }
    button.append(el('span', '', label));
    return button;
  });
  const create = el('button', 'wf-new');
  create.type = 'button';
  create.append(icon('plus'), el('span', '', NEW_NAME));
  const chipGroup = el('div', 'wf-chips');
  chipGroup.setAttribute('role', 'group');
  chipGroup.setAttribute('aria-label', 'Filtrar por desencadenante');
  chipGroup.append(...chips);
  toolbar.append(search, chipGroup, el('span', 'wf-spacer'), create);

  const table = el('div', 'wf-table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Workflows');
  const body = el('div', 'wf-rows');
  const pager = el('div', 'wf-pager');
  const pagerLabel = el('span', 'wf-pager-label');
  const prev = iconButton('chevron-left', 'Página anterior', 'wf-icon-btn');
  const pageText = el('span', 'wf-pager-page');
  const next = iconButton('chevron-right', 'Página siguiente', 'wf-icon-btn');
  pager.append(pagerLabel, prev, pageText, next);
  table.append(headRow(), body, pager);
  root.append(toolbar, table);
  deps.host.replaceChildren(root);

  function paintChips(): void {
    const counts = filterCounts(entries);
    for (const button of chips) {
      const value = button.dataset.filter as WorkflowFilter;
      button.setAttribute('aria-pressed', String(value === filter));
      const label = button.querySelector('span:last-child');
      if (label && value === 'all') label.textContent = `Todos · ${counts.all}`;
    }
  }

  function paintRows(): void {
    menu.close();
    const shown = listWorkflows(entries, { query, filter });
    const current = paginate(shown, page);
    page = current.page;
    const focusedRename =
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.classList.contains('wf-rename');
    body.replaceChildren(
      ...current.items.map((entry) =>
        buildRow({
          entry,
          groups: deps.getGroups(),
          now: now(),
          renaming: renaming?.id === entry.workflow.id ? renaming.value : null,
        }),
      ),
    );
    if (current.items.length === 0)
      body.append(
        el(
          'div',
          'wf-empty',
          entries.length === 0 ? 'Sin workflows' : 'Sin resultados',
        ),
      );
    pagerLabel.textContent = current.label;
    pageText.textContent = `${current.page + 1} / ${current.pages}`;
    prev.disabled = current.page === 0;
    next.disabled = current.page >= current.pages - 1;
    if (focusedRename)
      body.querySelector<HTMLInputElement>('.wf-rename')?.focus();
  }

  function paint(): void {
    paintChips();
    paintRows();
  }

  function entryOf(id: string | undefined): WorkflowEntry | undefined {
    return entries.find((entry) => entry.workflow.id === id);
  }

  async function run(id: string): Promise<void> {
    try {
      const outcome = await window.api.runWorkflow(id);
      const text = outcome.ok ? null : runErrorText(outcome.error);
      if (text) deps.showToast(text, 'error');
    } catch (error) {
      deps.showToast(reasonOf(error), 'error');
    }
  }

  async function setEnabled(id: string, toggle: HTMLInputElement) {
    try {
      await window.api.setWorkflowEnabled(id, toggle.checked);
    } catch {
      toggle.checked = !toggle.checked;
      deps.showToast('No se pudo guardar el ajuste', 'error');
    }
  }

  async function createNew(): Promise<void> {
    try {
      const created = await window.api.createWorkflow(NEW_NAME, MANUAL_TRIGGER);
      deps.open(created.id, { rename: true });
    } catch (error) {
      deps.showToast(reasonOf(error), 'error');
    }
  }

  async function duplicate(entry: WorkflowEntry): Promise<void> {
    const { workflow } = entry;
    try {
      const created = await window.api.createWorkflow(
        `${workflow.name} (copia)`,
        copyTrigger(workflow.trigger),
      );
      await window.api.saveWorkflow({
        ...created,
        showInTray: workflow.showInTray,
        showInRemote: workflow.showInRemote,
        graph: workflow.graph,
      });
    } catch (error) {
      deps.showToast(reasonOf(error), 'error');
    }
  }

  async function remove(entry: WorkflowEntry): Promise<void> {
    if (!confirm(`¿Eliminar el workflow «${entry.workflow.name}»?`)) return;
    const result = await window.api.deleteWorkflow(entry.workflow.id);
    if (!result.ok)
      deps.showToast(result.error || 'No se pudo eliminar', 'error');
  }

  function startRename(entry: WorkflowEntry): void {
    renaming = { id: entry.workflow.id, value: entry.workflow.name };
    paintRows();
    const input = body.querySelector<HTMLInputElement>('.wf-rename');
    input?.focus();
    input?.select();
  }

  async function commitRename(input: HTMLInputElement): Promise<void> {
    const entry = entryOf(renaming?.id);
    renaming = null;
    const name = input.value.trim();
    paintRows();
    if (!entry || !name || name === entry.workflow.name) return;
    try {
      await window.api.saveWorkflow({ ...entry.workflow, name });
    } catch (error) {
      deps.showToast(reasonOf(error), 'error');
    }
  }

  async function setShownIn(
    entry: WorkflowEntry,
    patch: Pick<Workflow, 'showInTray'> | Pick<Workflow, 'showInRemote'>,
  ): Promise<void> {
    try {
      await window.api.saveWorkflow({ ...entry.workflow, ...patch });
    } catch (error) {
      deps.showToast(reasonOf(error), 'error');
    }
  }

  function openMenu(trigger: HTMLButtonElement, entry: WorkflowEntry): void {
    const { showInTray, showInRemote } = entry.workflow;
    menu.toggle(trigger, [
      { label: 'Renombrar', icon: 'pencil', run: () => startRename(entry) },
      { label: 'Duplicar', icon: 'copy', run: () => void duplicate(entry) },
      null,
      {
        label: 'Mostrar en la barra',
        icon: 'panel-top',
        checked: showInTray,
        run: () => void setShownIn(entry, { showInTray: !showInTray }),
      },
      {
        label: 'Mostrar en el móvil',
        icon: 'smartphone',
        checked: showInRemote,
        run: () => void setShownIn(entry, { showInRemote: !showInRemote }),
      },
      null,
      {
        label: 'Eliminar',
        icon: 'trash-2',
        danger: true,
        run: () => void remove(entry),
      },
    ]);
  }

  function act(action: string, target: HTMLElement, entry: WorkflowEntry) {
    const id = entry.workflow.id;
    if (action === 'run' && target.getAttribute('aria-disabled') !== 'true')
      void run(id);
    else if (action === 'stop') void window.api.stopWorkflow(id);
    else if (action === 'menu' && target instanceof HTMLButtonElement)
      openMenu(target, entry);
  }

  body.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const row = target?.closest<HTMLElement>('.wf-row');
    const entry = entryOf(row?.dataset.id);
    if (!target || !entry) return;
    if (target.closest('.remote-menu, .wf-rename, .wf-switch')) return;
    const action = target.closest<HTMLElement>('[data-action]');
    if (action?.dataset.action) act(action.dataset.action, action, entry);
    else deps.open(entry.workflow.id);
  });

  body.addEventListener('change', (event) => {
    const toggle = event.target;
    if (
      !(toggle instanceof HTMLInputElement) ||
      toggle.dataset.action !== 'enable'
    )
      return;
    const id = toggle.closest<HTMLElement>('.wf-row')?.dataset.id;
    if (id) void setEnabled(id, toggle);
  });

  body.addEventListener('contextmenu', (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '.wf-row',
    );
    const entry = entryOf(row?.dataset.id);
    const more = row?.querySelector<HTMLButtonElement>('[data-action="menu"]');
    if (!entry || !more) return;
    event.preventDefault();
    openMenu(more, entry);
  });

  body.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains('wf-rename')) {
      if (event.key === 'Enter') void commitRename(target as HTMLInputElement);
      else if (event.key === 'Escape') {
        event.stopPropagation();
        renaming = null;
        paintRows();
      }
      return;
    }
    if (event.key !== 'Enter' || !target.classList.contains('wf-row')) return;
    const entry = entryOf(target.dataset.id);
    if (entry) deps.open(entry.workflow.id);
  });

  body.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (renaming && target.classList.contains('wf-rename'))
      renaming.value = target.value;
  });

  body.addEventListener('focusout', (event) => {
    const target = event.target as HTMLInputElement;
    if (renaming && target.classList.contains('wf-rename'))
      void commitRename(target);
  });

  field.addEventListener('input', () => {
    query = field.value;
    page = 0;
    paintRows();
  });
  for (const button of chips)
    button.addEventListener('click', () => {
      filter = button.dataset.filter as WorkflowFilter;
      page = 0;
      paint();
    });
  create.addEventListener('click', () => void createNew());
  prev.addEventListener('click', () => {
    page -= 1;
    paintRows();
  });
  next.addEventListener('click', () => {
    page += 1;
    paintRows();
  });

  return {
    render: (next) => {
      entries = next;
      paint();
    },
  };
}
