// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  chain,
  click,
  editorHarness,
  press,
  query,
  textOf,
  tick,
} from './helpers/pipeline-editor.js';
import {
  MANUAL,
  NIGHTLY,
  STARTUP,
  entryOf,
  workflow,
} from './helpers/workflows.js';
import { startupEntries, startupWorkflow } from './helpers/startup-workflow.js';
import type { Workflow, WorkflowTrigger } from '../src/domain-types.js';
import type { WorkflowEntry } from '../src/ipc-contract.js';

// 2026-01-05 is a Monday; 15:00.
const NOW = new Date(2026, 0, 5, 15, 0).getTime();

function popover(): HTMLElement {
  return query('.wf-pop');
}

function option(label: string): HTMLElement {
  const found = [
    ...popover().querySelectorAll<HTMLElement>('button, label'),
  ].find((candidate) => textOf(candidate) === label);
  if (!found) throw new Error(`the popover has no "${label}"`);
  return found;
}

describe('renderer/workflows/trigger-popover.ts', () => {
  const { openEditor, written } = editorHarness();

  /** Opens `mine` in the editor next to the startup workflow «Arranque». */
  async function openOn(trigger: WorkflowTrigger) {
    const mine = workflow('w2', trigger, { name: 'Backup', graph: chain() });
    let entries: WorkflowEntry[] = [...startupEntries(chain()), entryOf(mine)];
    const opened = await openEditor({ entries: () => entries, now: () => NOW });
    void opened.editor.open('w2');
    await opened.win.settle('listWorkflows', entries);
    click(query('.pipeline-trigger'));
    return {
      ...opened,
      setEntries: (next: WorkflowEntry[]) => {
        entries = next;
      },
    };
  }

  async function lastSaved(
    win: Awaited<ReturnType<typeof openOn>>['win'],
  ): Promise<Workflow> {
    await tick();
    const saved = win.argsFor('saveWorkflow').at(-1)?.[0] as Workflow;
    await win.settle('saveWorkflow', saved);
    return saved;
  }

  async function lastTrigger(
    win: Awaited<ReturnType<typeof openOn>>['win'],
  ): Promise<WorkflowTrigger> {
    return (await lastSaved(win)).trigger;
  }

  function toggle(label: string): void {
    option(label).querySelector('input')?.click();
  }

  it('opens from the trigger node on its current kind and closes on Escape', async () => {
    await openOn(MANUAL);
    expect(popover().hidden).toBe(false);
    expect(query('.pipeline-trigger').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(option('Manual').getAttribute('aria-checked')).toBe('true');
    press(document.body, 'Escape');
    expect(popover().hidden).toBe(true);
  });

  it('closes again from the trigger node and from a click outside', async () => {
    await openOn(MANUAL);
    click(query('.pipeline-trigger'));
    expect(popover().hidden).toBe(true);
    click(query('.pipeline-trigger'));
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(popover().hidden).toBe(true);
  });

  describe('manual', () => {
    it('toggles where it is offered and whether it asks first', async () => {
      const { win } = await openOn(MANUAL);
      expect(textOf(popover())).not.toContain('Listado de workflows');
      toggle('Control remoto');
      expect(await lastSaved(win)).toMatchObject({
        showInRemote: true,
        trigger: MANUAL,
      });
      toggle('Pedir confirmación antes de ejecutar');
      expect(await lastTrigger(win)).toEqual({ ...MANUAL, confirm: true });
    });

    it('becomes a schedule at 09:00 on weekdays', async () => {
      const { win } = await openOn(MANUAL);
      click(option('Programado'));
      expect(await lastTrigger(win)).toEqual({
        kind: 'schedule',
        schedule: {
          rules: [{ time: '09:00', days: [1, 2, 3, 4, 5] }],
          interval: null,
        },
      });
    });
  });

  describe('schedule', () => {
    it('edits the weekdays and the time, and says when it fires next', async () => {
      const { win } = await openOn(NIGHTLY);
      expect(option('A una hora').getAttribute('aria-checked')).toBe('true');
      expect(textOf(query('.wf-pop-next'))).toBe('Próxima: hoy a las 23:30');
      click(option('S'));
      expect(await lastTrigger(win)).toEqual({
        kind: 'schedule',
        schedule: {
          rules: [{ time: '23:30', days: [1, 2, 3, 4, 5, 6] }],
          interval: null,
        },
      });
      const time = query<HTMLInputElement>('.wf-time');
      time.value = '07:15';
      time.dispatchEvent(new Event('change'));
      const trigger = await lastTrigger(win);
      expect(
        trigger.kind === 'schedule' && trigger.schedule.rules[0]?.time,
      ).toBe('07:15');
    });

    it('switches to an interval and edits it', async () => {
      const { win } = await openOn(NIGHTLY);
      click(option('Cada…'));
      expect(await lastTrigger(win)).toEqual({
        kind: 'schedule',
        schedule: { rules: [], interval: { every: 1, unit: 'hours' } },
      });
    });

    it('edits the interval of an every-N schedule', async () => {
      const { win } = await openOn({
        kind: 'schedule',
        schedule: { rules: [], interval: { every: 2, unit: 'hours' } },
      });
      const every = query<HTMLInputElement>('.wf-every');
      expect(every.value).toBe('2');
      every.value = '15';
      query<HTMLSelectElement>('.wf-unit').value = 'minutes';
      every.dispatchEvent(new Event('change'));
      expect(await lastTrigger(win)).toEqual({
        kind: 'schedule',
        schedule: { rules: [], interval: { every: 15, unit: 'minutes' } },
      });
      click(option('A una hora'));
      expect(await lastTrigger(win)).toMatchObject({
        schedule: { interval: null },
      });
    });
  });

  describe('startup', () => {
    it('warns when another workflow holds the slot, and takes it on request', async () => {
      const { win } = await openOn(MANUAL);
      click(option('Al arrancar'));
      expect(win.callCount('saveWorkflow')).toBe(0);
      expect(textOf(query('.wf-pop-warn'))).toBe(
        'Ya lo usa «Arranque».Usar este en su lugar',
      );
      click(option('Usar este en su lugar'));
      expect(win.argsFor('makeStartupWorkflow')).toEqual([['w2']]);
      await win.settle('makeStartupWorkflow', [
        { ...startupWorkflow(chain()), trigger: MANUAL },
        workflow('w2', { kind: 'startup' }, { name: 'Backup', graph: chain() }),
      ]);
      expect(textOf(query('.pipeline-trigger'))).toBe('Al iniciar');
      expect(document.querySelector('.wf-pop-warn')).toBeNull();
      expect(option('Al arrancar').getAttribute('aria-checked')).toBe('true');
    });

    it('takes a free slot at once', async () => {
      const { win, editor, setEntries } = await openOn(MANUAL);
      setEntries([
        entryOf(workflow('w2', MANUAL, { name: 'Backup', graph: chain() })),
      ]);
      editor.entriesChanged();
      click(option('Al arrancar'));
      expect(await lastTrigger(win)).toEqual({ kind: 'startup' });
    });

    it('reports a swap main refused', async () => {
      const { win, toasts } = await openOn(MANUAL);
      click(option('Al arrancar'));
      click(option('Usar este en su lugar'));
      await win.fail('makeStartupWorkflow', new Error('no'));
      expect(toasts.at(-1)?.message).toBe(
        'No se pudo cambiar el desencadenante',
      );
    });
  });

  describe('mostrar en', () => {
    it.each([
      ['startup', STARTUP],
      ['schedule', NIGHTLY],
    ] as const)(
      'offers where a %s workflow shows, without the confirmation',
      async (_kind, trigger) => {
        const { win } = await openOn(trigger);
        const text = textOf(popover());
        expect(text).toContain('Mostrar en');
        expect(text).not.toContain('Pedir confirmación');
        toggle('Menú de la barra');
        expect(await lastSaved(win)).toMatchObject({
          showInTray: false,
          showInRemote: false,
          trigger,
        });
        toggle('Control remoto');
        expect(await lastSaved(win)).toMatchObject({ showInRemote: true });
      },
    );

    it('draws the switches from the workflow, below the schedule', async () => {
      await openOn(NIGHTLY);
      const tray = option('Menú de la barra').querySelector('input');
      expect(tray?.checked).toBe(true);
      const parts = [...popover().children].map((part) => part.className);
      expect(parts.indexOf('wf-pop-next')).toBeLessThan(
        parts.lastIndexOf('wf-pop-label'),
      );
    });
  });

  it('saves the trigger with the graph it already had', async () => {
    const { win } = await openOn(MANUAL);
    click(option('Programado'));
    expect((await written(win)).blocks).toHaveLength(2);
  });
});
