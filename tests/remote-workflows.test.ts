// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { RemoteWorkflowView } from '../src/ipc-contract/remote-wire.js';
import {
  buttonNamed,
  byId,
  NOW,
  settle,
  startLinked,
  state,
  tap,
  tabButton,
  text,
  visibleTab,
} from './helpers/remote-page.js';

/**
 * «Workflows»: its own screen on the phone — the runs in flight, with their
 * progress and a way to stop them, and the ones it may start.
 */

const workflow = (
  extra: Partial<RemoteWorkflowView> = {},
): RemoteWorkflowView => ({
  id: 'w1',
  name: 'Backup',
  startup: false,
  trigger: 'manual',
  running: false,
  hidden: false,
  doneScripts: null,
  totalScripts: 2,
  startedAt: null,
  nextRunAt: null,
  lastResult: null,
  lastFinishedAt: null,
  ...extra,
});

const RUNNING = workflow({
  id: 'boot',
  name: 'Arranque del entorno',
  startup: true,
  trigger: 'startup',
  running: true,
  doneScripts: 3,
  totalScripts: 8,
  startedAt: NOW - 72_000,
});

/** Mon 28 Sep 2026, 17:12 — three days before NOW. */
const MONDAY = new Date(2026, 8, 28, 17, 12).getTime();

const rows = (id: string): HTMLElement[] => [
  ...byId(id).querySelectorAll<HTMLElement>('.wf-row'),
];
const rowText = (row: HTMLElement | undefined, selector: string): string =>
  row?.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

async function onWorkflows(workflows: RemoteWorkflowView[]) {
  const h = await startLinked(state({ workflows }));
  tap(tabButton('workflows'));
  return h;
}

describe('renderer/remote/workflows-tab.ts', () => {
  describe('the screen', () => {
    it('opens from the side menu, under its own title', async () => {
      await onWorkflows([workflow()]);

      expect(visibleTab()).toBe('workflows');
      expect(text('screen-title')).toBe('Workflows');
    });

    it('no longer crowds the groups screen', async () => {
      await startLinked(state({ workflows: [workflow()] }));

      expect(byId('tab-groups').textContent).not.toContain('Backup');
    });

    it('says when DevBar has none to offer', async () => {
      await onWorkflows([]);

      expect(byId('workflows-empty').hidden).toBe(false);
      expect(byId('workflows-running-title').hidden).toBe(true);
      expect(byId('workflows-idle-title').hidden).toBe(true);
    });
  });

  describe('«En curso»', () => {
    it('shows each run with its scripts, how long it has run and a bar', async () => {
      await onWorkflows([RUNNING, workflow()]);

      const [row] = rows('workflows-running');
      expect(byId('workflows-running-title').hidden).toBe(false);
      expect(rowText(row, '.wf-name')).toBe('Arranque del entorno');
      expect(rowText(row, '.wf-sub')).toBe('3/8 · 1m 12s');
      expect(row?.querySelector('.spinner')).not.toBeNull();
      expect(
        row?.querySelector<HTMLElement>('.wf-progress-bar')?.style.width,
      ).toBe('37.5%');
      expect(row?.querySelector('.wf-tile.is-startup')).not.toBeNull();
    });

    it('keeps the time ticking between pushes', async () => {
      const h = await onWorkflows([RUNNING]);

      h.advance(10_000);
      h.beat();

      expect(rowText(rows('workflows-running')[0], '.wf-sub')).toBe(
        '3/8 · 1m 22s',
      );
    });

    it('stops a run', async () => {
      const h = await onWorkflows([RUNNING]);
      h.answer('workflow.stop', { status: 200, body: { ok: true } });

      tap(buttonNamed('Detener Arranque del entorno'));
      await settle();

      expect(h.callsTo('workflow.stop')[0]?.body).toEqual({
        workflowId: 'boot',
      });
    });

    it('hides the section when nothing runs', async () => {
      await onWorkflows([workflow()]);

      expect(byId('workflows-running-title').hidden).toBe(true);
      expect(rows('workflows-running')).toEqual([]);
    });
  });

  describe('«Disponibles»', () => {
    it('says how each one fires and how it last went, coloured by result', async () => {
      await onWorkflows([
        workflow({
          id: 'a',
          name: 'Reset de datos de demo',
          lastResult: 'warning',
          lastFinishedAt: MONDAY,
        }),
        workflow({
          id: 'b',
          name: 'Backup nocturno BD',
          trigger: 'schedule',
          nextRunAt: new Date(2026, 9, 1, 23, 30).getTime(),
        }),
        workflow({ id: 'c', name: 'Al abrir', trigger: 'startup' }),
      ]);

      const [manual, scheduled, startup] = rows('workflows-idle');
      expect(rowText(manual, '.wf-sub')).toBe(
        'Manual · lun 17:12 · con avisos',
      );
      expect(rowText(manual, '.wf-result.is-warning')).toBe('con avisos');
      expect(manual?.querySelector('.wf-tile.is-manual')).not.toBeNull();
      expect(rowText(scheduled, '.wf-sub')).toBe('Programado · hoy 23:30');
      expect(scheduled?.querySelector('.wf-tile.is-schedule')).not.toBeNull();
      expect(rowText(startup, '.wf-sub')).toBe('Al arrancar');
    });

    it('runs one, and cannot run one with nothing to run', async () => {
      const h = await onWorkflows([
        workflow(),
        workflow({ id: 'w2', name: 'Vacío', totalScripts: 0 }),
      ]);
      h.answer('workflow.run', { status: 202, body: { pending: true } });

      expect(buttonNamed('Ejecutar Vacío').disabled).toBe(true);
      tap(buttonNamed('Ejecutar Backup'));
      await settle();

      expect(h.callsTo('workflow.run')[0]?.body).toEqual({ workflowId: 'w1' });
      expect(text('toast')).toBe('Pendiente de confirmación');
    });

    it('folds the workflows hidden from the tray, like the tray does', async () => {
      await onWorkflows([
        workflow(),
        workflow({ id: 'w2', name: 'Limpieza', hidden: true }),
        workflow({ id: 'w3', name: 'Seed', hidden: true }),
      ]);
      const names = (): string[] =>
        rows('workflows-idle').map((row) => rowText(row, '.wf-name'));

      expect(names()).toEqual(['Backup']);
      const toggle = byId('workflows-idle').querySelector<HTMLButtonElement>(
        '.hidden-groups-toggle',
      );
      expect(toggle?.textContent).toContain('2 ocultos');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      tap(toggle);
      expect(names()).toEqual(['Backup', 'Limpieza', 'Seed']);
      expect(
        byId('workflows-idle').querySelectorAll('.wf-row.is-hidden-group'),
      ).toHaveLength(2);
    });
  });

  describe('in the menu', () => {
    it('marks the menu button and counts the runs in flight', async () => {
      await startLinked(state({ workflows: [RUNNING, workflow()] }));

      expect(byId('menu-dot').hidden).toBe(false);
      expect(text('drawer-count-workflows')).toBe('1');
      expect(byId('drawer-count-workflows').hidden).toBe(false);
    });

    it('stays quiet when nothing runs', async () => {
      await startLinked(state({ workflows: [workflow()] }));

      expect(byId('menu-dot').hidden).toBe(true);
      expect(byId('drawer-count-workflows').hidden).toBe(true);
    });
  });
});
