// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconText } from './helpers/icon-text.js';
import { tipOf } from './helpers/tip.js';
import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import {
  MANUAL,
  NIGHTLY,
  STARTUP,
  cellText,
  rowFor,
  rows,
  wfEntry,
  workflow,
} from './helpers/workflows.js';
import {
  createWorkflowList,
  type WorkflowListView,
} from '../renderer/workflows/list-view.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { WorkflowEntry } from '../src/ipc-contract.js';
import type { Workflow } from '../src/domain-types.js';

// 2026-01-05 is a Monday.
const NOW = new Date(2026, 0, 5, 15, 0).getTime();

const GROUPS = [normalizeGroup({ id: 'back', name: 'Back', path: '/b' })];

function click(target: Element | null): void {
  if (!target) throw new Error('nothing to click');
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

function chip(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('.wf-chip'),
  ].find((candidate) =>
    candidate.textContent?.replace(/[-]/g, '').trim().startsWith(label),
  );
  if (!found) throw new Error(`no "${label}" chip`);
  return found;
}

const SAMPLE: WorkflowEntry[] = [
  wfEntry(
    'backup',
    NIGHTLY,
    {
      lastRun: {
        startedAt: new Date(2026, 0, 4, 23, 30).getTime(),
        finishedAt: new Date(2026, 0, 4, 23, 31).getTime(),
        durationMs: 42_000,
        result: 'success',
      },
    },
    { name: 'Backup nocturno' },
  ),
  wfEntry(
    'boot',
    STARTUP,
    {
      running: { runId: 1, doneScripts: 3, totalScripts: 8, startedAt: NOW },
    },
    {
      name: 'Arranque',
      showInRemote: true,
      graph: {
        blocks: [
          {
            id: 'a',
            scripts: [{ groupId: 'back', scriptId: 's' }],
            x: 0,
            y: 0,
            requireAll: true,
          },
        ],
        edges: [],
      },
    },
  ),
  wfEntry('demo', MANUAL, {}, { name: 'Demo', enabled: false }),
];

describe('renderer/workflows/list-view.ts', () => {
  let win: RendererWindow | null = null;
  let opened: Array<[string, unknown]> = [];
  let toasts: string[] = [];

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
  });

  async function mount(entries = SAMPLE): Promise<WorkflowListView> {
    win = await loadRendererWindow({
      html: 'config.html',
      load: () => Promise.resolve(),
    });
    opened = [];
    toasts = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createWorkflowList({
      host,
      getGroups: () => GROUPS,
      now: () => NOW,
      open: (id, options) => opened.push([id, options]),
      showToast: (message) => toasts.push(message),
    });
    view.render(entries);
    return view;
  }

  describe('rows', () => {
    it('lists the startup workflow first, highlighted with the lightning tile', async () => {
      await mount();
      expect(rows().map((row) => row.dataset.id)).toEqual([
        'boot',
        'backup',
        'demo',
      ]);
      const boot = rowFor('boot');
      expect(boot.classList.contains('is-startup')).toBe(true);
      expect(iconText(boot.querySelector('.wf-tile'))).toBe('[zap]');
      expect(cellText(boot, '.wf-name')).toBe('Arranque');
      expect(cellText(boot, '.wf-sub')).toBe('1 script · Back');
      expect(cellText(boot, '.wf-pill')).toBe('Al arrancar');
    });

    it('summarises a schedule and the last run', async () => {
      await mount();
      const backup = rowFor('backup');
      expect(cellText(backup, '.wf-pill')).toBe('Programado');
      expect(cellText(backup, '.wf-trigger-sub')).toBe('L–V a las 23:30');
      expect(cellText(backup, '.wf-last')).toBe('ayer 23:30 · 42s');
      expect(cellText(backup, '.wf-status')).toBe('Correcto');
      expect(cellText(rowFor('demo'), '.wf-last')).toBe('Nunca');
    });

    it('repeats the last run under the name, for the layout without its column', async () => {
      await mount();
      expect(cellText(rowFor('backup'), '.wf-sub-last')).toBe(
        '· ayer 23:30 · 42s',
      );
      expect(rowFor('demo').querySelector('.wf-sub-last')).toBeNull();
      const heads = [...q('.wf-head').children];
      const last = heads.find(
        (head) => head.textContent === 'Última ejecución',
      );
      expect(last?.classList.contains('wf-cell-last')).toBe(true);
    });

    it('groups the filter chips so they wrap as one line of their own', async () => {
      await mount();
      expect(
        q('.wf-toolbar .wf-chips').querySelectorAll('.wf-chip'),
      ).toHaveLength(4);
    });

    it('pulses a running status and dims a disabled row', async () => {
      await mount();
      const status = q('.wf-row[data-id="boot"] .wf-status');
      expect(status.textContent?.trim()).toBe('Ejecutando · 3/8');
      expect(status.classList.contains('is-running')).toBe(true);
      expect(rowFor('demo').classList.contains('is-off')).toBe(true);
      expect(cellText(rowFor('demo'), '.wf-status')).toBe('Inactivo');
    });

    it('says so when there is nothing, or nothing matches', async () => {
      const view = await mount([]);
      expect(q('.wf-empty').textContent).toBe('Sin workflows');
      view.render(SAMPLE);
      q<HTMLInputElement>('.wf-search input').value = 'zzz';
      q('.wf-search input').dispatchEvent(new Event('input'));
      expect(q('.wf-empty').textContent).toBe('Sin resultados');
    });
  });

  describe('filters and pages', () => {
    it('counts all workflows on the first chip and filters by trigger', async () => {
      await mount();
      expect(chip('Todos').textContent?.trim()).toBe('Todos · 3');
      expect(chip('Todos').getAttribute('aria-pressed')).toBe('true');
      click(chip('Programados'));
      expect(rows().map((row) => row.dataset.id)).toEqual(['backup']);
      expect(chip('Programados').getAttribute('aria-pressed')).toBe('true');
      expect(chip('Todos').getAttribute('aria-pressed')).toBe('false');
    });

    it('searches by name', async () => {
      await mount();
      const input = q<HTMLInputElement>('.wf-search input');
      expect(input.getAttribute('aria-label')).toBe('Buscar workflow');
      input.value = 'demo';
      input.dispatchEvent(new Event('input'));
      expect(rows().map((row) => row.dataset.id)).toEqual(['demo']);
    });

    it('pages ten rows at a time', async () => {
      const many = Array.from({ length: 12 }, (_, i) =>
        wfEntry(`w${i}`, MANUAL),
      );
      await mount(many);
      expect(rows()).toHaveLength(10);
      expect(q('.wf-pager-label').textContent).toBe('1–10 de 12');
      const prev = q<HTMLButtonElement>('[aria-label="Página anterior"]');
      const next = q<HTMLButtonElement>('[aria-label="Página siguiente"]');
      expect(prev.disabled).toBe(true);
      click(next);
      expect(rows().map((row) => row.dataset.id)).toEqual(['w10', 'w11']);
      expect(q('.wf-pager-page').textContent).toBe('2 / 2');
      expect(next.disabled).toBe(true);
      click(prev);
      expect(rows()).toHaveLength(10);
    });
  });

  describe('actions', () => {
    it('runs an idle workflow and stops a running one', async () => {
      await mount();
      click(rowFor('backup').querySelector('[aria-label="Ejecutar ahora"]'));
      expect(win?.argsFor('runWorkflow')).toEqual([['backup']]);
      click(rowFor('boot').querySelector('[aria-label="Detener"]'));
      expect(win?.argsFor('stopWorkflow')).toEqual([['boot']]);
      expect(opened).toEqual([]);
    });

    it('offers no run for a disabled workflow and explains an empty one', async () => {
      await mount([
        wfEntry('off', MANUAL, {}, { enabled: false }),
        wfEntry('empty', MANUAL, { scriptCount: 0 }),
      ]);
      expect(
        rowFor('off').querySelector('[aria-label="Ejecutar ahora"]'),
      ).toBeNull();
      const run = rowFor('empty').querySelector(
        '[aria-label="Ejecutar ahora"]',
      );
      expect(run?.getAttribute('aria-disabled')).toBe('true');
      expect(tipOf(run)).toBe('Sin scripts conectados');
      click(run);
      expect(win?.callCount('runWorkflow')).toBe(0);
    });

    it('reports a run that main refused', async () => {
      await mount();
      click(rowFor('backup').querySelector('[aria-label="Ejecutar ahora"]'));
      await win?.settle('runWorkflow', { ok: false, error: 'already_running' });
      expect(toasts).toEqual(['Ya se está ejecutando']);
    });

    it('toggles enabled from the switch, rolling back a failed save', async () => {
      await mount();
      const toggle = rowFor('backup').querySelector<HTMLInputElement>(
        'input[role="switch"]',
      );
      if (!toggle) throw new Error('no switch');
      expect(toggle.checked).toBe(true);
      toggle.click();
      expect(win?.argsFor('setWorkflowEnabled')).toEqual([['backup', false]]);
      await win?.fail('setWorkflowEnabled', new Error('disco lleno'));
      expect(toggle.checked).toBe(true);
      expect(toasts).toEqual(['No se pudo guardar el ajuste']);
      expect(opened).toEqual([]);
    });

    it('opens the editor on a row click or Enter', async () => {
      await mount();
      click(rowFor('backup').querySelector('.wf-name'));
      rowFor('demo').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      expect(opened.map(([id]) => id)).toEqual(['backup', 'demo']);
    });

    it('creates a manual workflow and opens it ready to rename', async () => {
      await mount();
      click(q('.wf-new'));
      expect(win?.argsFor('createWorkflow')).toEqual([
        ['Nuevo workflow', { kind: 'manual', confirm: false }],
      ]);
      await win?.settle('createWorkflow', workflow('fresh', MANUAL));
      expect(opened).toEqual([['fresh', { rename: true }]]);
    });

    it('reports a creation main refused', async () => {
      await mount();
      click(q('.wf-new'));
      await win?.fail('createWorkflow', new Error('Nombre vacío'));
      expect(toasts).toEqual(['Nombre vacío']);
    });
  });

  describe('row menu', () => {
    function menuItem(id: string, label: string): HTMLElement {
      click(rowFor(id).querySelector('[aria-label="Más acciones"]'));
      const item = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"]',
        ),
      ].find((candidate) => candidate.textContent?.includes(label));
      if (!item) throw new Error(`no "${label}" item`);
      return item;
    }

    it('renames in place, saving on Enter', async () => {
      await mount();
      click(menuItem('backup', 'Renombrar'));
      const input = q<HTMLInputElement>('.wf-row[data-id="backup"] .wf-rename');
      expect(document.activeElement).toBe(input);
      input.value = 'Copia de BD';
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      const saved = win?.argsFor('saveWorkflow')[0]?.[0] as {
        name: string;
        id: string;
      };
      expect(saved).toMatchObject({ id: 'backup', name: 'Copia de BD' });
      expect(opened).toEqual([]);
    });

    it('drops a rename on Escape', async () => {
      await mount();
      click(menuItem('backup', 'Renombrar'));
      const input = q<HTMLInputElement>('.wf-rename');
      input.value = 'X';
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      expect(document.querySelector('.wf-rename')).toBeNull();
      expect(win?.callCount('saveWorkflow')).toBe(0);
    });

    it('duplicates as a manual copy with the same graph', async () => {
      await mount();
      click(menuItem('boot', 'Duplicar'));
      expect(win?.argsFor('createWorkflow')).toEqual([
        ['Arranque (copia)', MANUAL],
      ]);
      await win?.settle(
        'createWorkflow',
        workflow('copy', MANUAL, { name: 'Arranque (copia)' }),
      );
      const saved = win?.argsFor('saveWorkflow')[0]?.[0] as Workflow;
      expect(saved.id).toBe('copy');
      expect(saved.graph).toEqual(SAMPLE[1]?.workflow.graph);
      // The copy shows where the original did (the startup one: the phone).
      expect(saved).toMatchObject({ showInTray: true, showInRemote: true });
    });

    it('shows where the workflow appears as checkable items', async () => {
      await mount();
      click(rowFor('backup').querySelector('[aria-label="Más acciones"]'));
      const checks = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
      ].map((item) => [
        // [icon, label, check]: the icon glyphs are text too.
        item.children[1]?.textContent,
        item.getAttribute('aria-checked'),
        // `hidden` loses to `.icon { display }`, so only a real mark counts.
        item.querySelector('.remote-menu-check') !== null,
      ]);
      expect(checks).toEqual([
        ['Mostrar en la barra', 'true', true],
        ['Mostrar en el móvil', 'false', false],
      ]);
    });

    it('toggles the tray and phone visibility from the menu', async () => {
      await mount();
      click(menuItem('backup', 'Mostrar en el móvil'));
      expect(win?.argsFor('saveWorkflow')[0]?.[0]).toMatchObject({
        id: 'backup',
        showInTray: true,
        showInRemote: true,
      });
      click(menuItem('backup', 'Mostrar en la barra'));
      expect(win?.argsFor('saveWorkflow')[1]?.[0]).toMatchObject({
        id: 'backup',
        showInTray: false,
      });
    });

    it('deletes after confirming', async () => {
      await mount();
      const ask = vi
        .spyOn(window, 'confirm')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      click(menuItem('demo', 'Eliminar'));
      expect(win?.callCount('deleteWorkflow')).toBe(0);
      click(menuItem('demo', 'Eliminar'));
      expect(ask).toHaveBeenLastCalledWith('¿Eliminar el workflow «Demo»?');
      expect(win?.argsFor('deleteWorkflow')).toEqual([['demo']]);
    });

    it('opens the same menu on a right click', async () => {
      await mount();
      rowFor('demo').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
    });
  });
});
