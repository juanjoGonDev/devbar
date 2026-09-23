// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  action,
  command,
  group,
  keyboardReorder,
  openConfigWindow,
  preScript,
  recordApiCalls,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { Group } from '../src/domain-types.js';

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function prescriptRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.prescript-row')];
}

function itemRows(kind: 'command' | 'action'): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `.sub-item-list[data-kind="${kind}"] .sub-item-row`,
    ),
  ];
}

function textOf(row: HTMLElement, selector: string): string {
  return row.querySelector<HTMLElement>(selector)?.textContent ?? '';
}

function addButtonFor(label: string): HTMLButtonElement {
  const el = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#group-detail .sub-list-header .small-btn',
    ),
  ].find((b) => b.textContent === label);
  if (!el) throw new Error(`no add button "${label}"`);
  return el;
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

function renameGroup(value: string): void {
  const el = document.querySelector<HTMLInputElement>('.detail-name-input');
  if (!el) throw new Error('the detail pane drew no name field');
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

function savedGroup(calls: unknown[][]): Group {
  const last = calls.at(-1);
  if (!last) throw new Error('the pane never saved the group');
  return last[0] as Group;
}

function dialogOpen(): boolean {
  const el = document.getElementById('sub-dialog');
  return el instanceof HTMLDialogElement && el.open;
}

describe('renderer/config/sub-lists.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
  });

  async function open(extra: Partial<Group>): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api', extra)]);
    return win;
  }

  describe('pre-script library', () => {
    it('explains itself when the group defines none', async () => {
      await open({});
      expect(document.querySelector('.prestep-empty')?.textContent).toContain(
        '+ Añadir pre-script',
      );
      expect(prescriptRows()).toHaveLength(0);
    });

    it('lists each definition with its full command line', async () => {
      await open({ preScripts: [preScript('seed')] });
      expect(prescriptRows()).toHaveLength(1);
      expect(textOf(prescriptRows()[0], 'strong')).toBe('seed');
      expect(textOf(prescriptRows()[0], 'code')).toBe('docker up');
    });

    it('falls back to "Unnamed" and to the bare command', async () => {
      await open({
        preScripts: [preScript('x', { name: '', args: [] })],
      });
      expect(textOf(prescriptRows()[0], 'strong')).toBe('Unnamed');
      expect(textOf(prescriptRows()[0], 'code')).toBe('docker');
    });

    it('opens the editor from the add and edit buttons', async () => {
      await open({ preScripts: [preScript('seed')] });
      click(addButtonFor('+ Añadir pre-script'));
      expect(dialogOpen()).toBe(true);
      expect(document.getElementById('sub-dialog-title')?.textContent).toBe(
        'Nuevo pre-script',
      );
      click(prescriptRows()[0].querySelector('.small-btn'));
      expect(document.getElementById('sub-dialog-title')?.textContent).toBe(
        'Editar pre-script: seed',
      );
    });

    it('keeps the definition when the user backs out of deleting it', async () => {
      const w = await open({ preScripts: [preScript('seed')] });
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      click(prescriptRows()[0].querySelector('.danger'));
      expect(w.callCount('deletePreScript')).toBe(0);
    });

    it('drops the definition and re-reads the pipeline it may prune', async () => {
      const w = await open({ preScripts: [preScript('seed')] });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(prescriptRows()[0].querySelector('.danger'));
      await w.settle('deletePreScript', { ok: true });
      await w.settle('listGroups', [group('api')]);
      await w.settle('getPreSteps', []);
      expect(prescriptRows()).toHaveLength(0);
      expect(document.querySelector('.prestep-empty')).not.toBeNull();
    });
  });

  describe('commands and actions', () => {
    it('lists each item with its icon, name and command line', async () => {
      await open({ commands: [command('api')], actions: [action('seed')] });
      expect(itemRows('command')).toHaveLength(1);
      expect(textOf(itemRows('command')[0], '.sub-icon')).toBe('⚙️');
      expect(textOf(itemRows('command')[0], '.sub-name')).toBe('api');
      expect(textOf(itemRows('command')[0], '.sub-cmd')).toBe('npm run api');
      expect(textOf(itemRows('action')[0], '.sub-name')).toBe('seed');
    });

    it('omits the icon slot for an item without one', async () => {
      await open({ commands: [command('api', { icon: null })] });
      expect(itemRows('command')[0].querySelector('.sub-icon')).toBeNull();
    });

    it('opens the editor from the add and edit buttons', async () => {
      await open({ commands: [command('api')] });
      click(addButtonFor('+ Añadir comando'));
      expect(document.getElementById('sub-dialog-title')?.textContent).toBe(
        'Nuevo comando',
      );
      click(addButtonFor('+ Añadir acción'));
      expect(document.getElementById('sub-dialog-title')?.textContent).toBe(
        'Nueva acción',
      );
      const edit = [
        ...itemRows('command')[0].querySelectorAll<HTMLButtonElement>(
          '.sub-actions .small-btn',
        ),
      ].find((b) => b.textContent === '✎');
      click(edit);
      expect(document.getElementById('sub-dialog-title')?.textContent).toBe(
        'Editar comando: api',
      );
    });
  });

  describe('auto-start toggle', () => {
    it('is offered for commands only', async () => {
      await open({ commands: [command('api')], actions: [action('seed')] });
      expect(
        itemRows('command')[0].querySelector('.autostart-toggle'),
      ).not.toBeNull();
      expect(
        itemRows('action')[0].querySelector('.autostart-toggle'),
      ).toBeNull();
    });

    it('reads its own state into the tooltip', async () => {
      await open({ commands: [command('api', { autoStart: true })] });
      const toggle = itemRows('command')[0].querySelector('.autostart-toggle');
      expect(toggle?.classList.contains('is-on')).toBe(true);
      expect(toggle?.getAttribute('title')).toContain('click para desactivar');
    });

    it('flips the flag and repaints the list', async () => {
      const w = await open({ commands: [command('api')] });
      click(itemRows('command')[0].querySelector('.autostart-toggle'));
      await w.settle('setCommandAutoStart', { ok: true });
      await w.settle('listGroups', [
        group('api', { commands: [command('api', { autoStart: true })] }),
      ]);
      expect(
        itemRows('command')[0]
          .querySelector('.autostart-toggle')
          ?.classList.contains('is-on'),
      ).toBe(true);
    });

    it('survives the next save of a pane that already had edits', async () => {
      // The toggle is an INSTANT write: it lands on disk on its own, while the
      // pane keeps rendering (and saving) its draft. Without folding the
      // persisted slice back into that draft, the next save writes the old
      // commands over it and the flag the user just set is gone.
      const w = await open({ commands: [command('api')] });
      renameGroup('api-edited');
      click(itemRows('command')[0].querySelector('.autostart-toggle'));
      await w.settle('setCommandAutoStart', { ok: true });
      await w.settle('listGroups', [
        group('api', { commands: [command('api', { autoStart: true })] }),
      ]);
      const saves = recordApiCalls('saveGroup');
      document.getElementById('detail-save')?.click();
      expect(savedGroup(saves).commands[0]?.autoStart).toBe(true);
    });

    it('surfaces a refused flip and leaves the list alone', async () => {
      const w = await open({ commands: [command('api')] });
      click(itemRows('command')[0].querySelector('.autostart-toggle'));
      await w.settle('setCommandAutoStart', { ok: false, error: 'busy' });
      expect(toastText()).toBe('Error: busy');
      expect(w.callCount('listGroups')).toBe(1);
    });

    it('falls back to a generic reason when main gives none', async () => {
      const w = await open({ commands: [command('api')] });
      click(itemRows('command')[0].querySelector('.autostart-toggle'));
      await w.settle('setCommandAutoStart', { ok: false });
      expect(toastText()).toBe('Error: desconocido');
    });
  });

  describe('schedule badge', () => {
    const scheduled = {
      enabled: true,
      rules: [{ time: '09:00', days: [1, 5] }],
    };

    it('appears only for an item with a live schedule', async () => {
      await open({
        commands: [
          command('api', { schedule: scheduled }),
          command('web', { schedule: { enabled: false, rules: [] } }),
        ],
      });
      const [withBadge, without] = itemRows('command');
      expect(
        withBadge.querySelector('.schedule-badge')?.getAttribute('title'),
      ).toContain('09:00 LV');
      expect(without.querySelector('.schedule-badge')).toBeNull();
    });

    it('stays away when the schedule is on but empty', async () => {
      await open({
        commands: [command('api', { schedule: { enabled: true, rules: [] } })],
      });
      expect(
        itemRows('command')[0].querySelector('.schedule-badge'),
      ).toBeNull();
    });

    it('opens the editor where the schedule lives', async () => {
      await open({ commands: [command('api', { schedule: scheduled })] });
      click(itemRows('command')[0].querySelector('.schedule-badge'));
      expect(document.getElementById('sub-dialog-title')?.textContent).toBe(
        'Editar comando: api',
      );
    });
  });

  describe('reordering', () => {
    it('persists a new pre-script order and folds it into the draft', async () => {
      const w = await open({
        preScripts: [preScript('seed'), preScript('reset')],
      });
      renameGroup('api-edited');
      keyboardReorder(prescriptRows()[0], 'down');
      expect(w.callCount('reorderPreScripts')).toBe(1);
      await w.settle('reorderPreScripts', { ok: true });
      await w.settle('listGroups', [
        group('api', { preScripts: [preScript('reset'), preScript('seed')] }),
      ]);
      const saves = recordApiCalls('saveGroup');
      document.getElementById('detail-save')?.click();
      expect(savedGroup(saves).preScripts.map((p) => p.name)).toEqual([
        'reset',
        'seed',
      ]);
    });

    it('persists a new command order and folds it into the draft', async () => {
      const w = await open({ commands: [command('api'), command('web')] });
      renameGroup('api-edited');
      keyboardReorder(itemRows('command')[0], 'down');
      expect(w.callCount('reorderCommands')).toBe(1);
      await w.settle('reorderCommands', { ok: true });
      await w.settle('listGroups', [
        group('api', { commands: [command('web'), command('api')] }),
      ]);
      const saves = recordApiCalls('saveGroup');
      document.getElementById('detail-save')?.click();
      expect(savedGroup(saves).commands.map((c) => c.name)).toEqual([
        'web',
        'api',
      ]);
    });

    it('persists a new action order', async () => {
      const w = await open({ actions: [action('seed'), action('reset')] });
      keyboardReorder(itemRows('action')[0], 'down');
      expect(w.callCount('reorderActions')).toBe(1);
      await w.settle('reorderActions', { ok: true });
      await w.settle('listGroups', [
        group('api', { actions: [action('reset'), action('seed')] }),
      ]);
      expect(itemRows('action').map((r) => textOf(r, '.sub-name'))).toEqual([
        'reset',
        'seed',
      ]);
    });
  });

  describe('deleting an item', () => {
    it('does nothing when the user backs out', async () => {
      const w = await open({ commands: [command('api')] });
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      click(itemRows('command')[0].querySelector('.sub-actions .danger'));
      expect(w.callCount('deleteCommand')).toBe(0);
    });

    it('keeps the row visible when main refuses', async () => {
      const w = await open({ commands: [command('api')] });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(itemRows('command')[0].querySelector('.sub-actions .danger'));
      await w.settle('deleteCommand', { ok: false, error: 'still running' });
      expect(toastText()).toBe('still running');
      expect(itemRows('command')).toHaveLength(1);
    });

    it('falls back to a generic reason when main gives none', async () => {
      const w = await open({ commands: [command('api')] });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(itemRows('command')[0].querySelector('.sub-actions .danger'));
      await w.settle('deleteCommand', { ok: false });
      expect(toastText()).toBe('No se pudo borrar el elemento');
    });

    it('drops a deleted command from the list', async () => {
      const w = await open({ commands: [command('api')] });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(itemRows('command')[0].querySelector('.sub-actions .danger'));
      await w.settle('deleteCommand', { ok: true });
      await w.settle('listGroups', [group('api')]);
      expect(itemRows('command')).toHaveLength(0);
    });

    it('does not resurrect a deleted command on the next save', async () => {
      // Deleting writes straight to the store; the pane still saves its draft.
      const w = await open({ commands: [command('api'), command('web')] });
      renameGroup('api-edited');
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(itemRows('command')[0].querySelector('.sub-actions .danger'));
      await w.settle('deleteCommand', { ok: true });
      await w.settle('listGroups', [
        group('api', { commands: [command('web')] }),
      ]);
      const saves = recordApiCalls('saveGroup');
      document.getElementById('detail-save')?.click();
      expect(savedGroup(saves).commands.map((c) => c.name)).toEqual(['web']);
    });

    it('does not resurrect a deleted action on the next save', async () => {
      const w = await open({ actions: [action('seed'), action('reset')] });
      renameGroup('api-edited');
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(itemRows('action')[0].querySelector('.sub-actions .danger'));
      await w.settle('deleteAction', { ok: true });
      await w.settle('listGroups', [
        group('api', { actions: [action('reset')] }),
      ]);
      const saves = recordApiCalls('saveGroup');
      document.getElementById('detail-save')?.click();
      expect(savedGroup(saves).actions.map((a) => a.name)).toEqual(['reset']);
    });

    it('drops a deleted action from the list', async () => {
      const w = await open({ actions: [action('seed')] });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(itemRows('action')[0].querySelector('.sub-actions .danger'));
      await w.settle('deleteAction', { ok: true });
      await w.settle('listGroups', [group('api')]);
      expect(itemRows('action')).toHaveLength(0);
    });
  });
});
