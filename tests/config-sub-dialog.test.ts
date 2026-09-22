// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  action,
  command,
  group,
  openConfigWindow,
  preScript,
  recordApiCalls,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { Group } from '../src/domain-types.js';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}

function input(id: string): HTMLInputElement {
  return el<HTMLInputElement>(id);
}

function click(target: Element | null | undefined): void {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function dialog(): HTMLDialogElement {
  return el<HTMLDialogElement>('sub-dialog');
}

function submit(): void {
  el('sub-form').dispatchEvent(new Event('submit', { cancelable: true }));
}

function addButton(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#group-detail .sub-list-header .small-btn',
    ),
  ].find((b) => b.textContent === label);
  if (!found) throw new Error(`no add button "${label}"`);
  return found;
}

function editButtonIn(selector: string): HTMLButtonElement {
  const row = document.querySelector<HTMLElement>(selector);
  const found = [
    ...(row?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((b) => b.textContent === '✎');
  if (!found) throw new Error(`no edit button in ${selector}`);
  return found;
}

function payload(calls: unknown[][]): Record<string, unknown> {
  const last = calls.at(-1);
  if (!last) throw new Error('nothing was saved');
  return last[1] as Record<string, unknown>;
}

function toastText(): string {
  return document.getElementById('toast')?.textContent ?? '';
}

describe('renderer/config/sub-dialog.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
  });

  async function open(extra: Partial<Group> = {}): Promise<RendererWindow> {
    win = await openConfigWindow();
    await win.settle('listGroups', [group('api', extra)]);
    return win;
  }

  describe('opening for a command', () => {
    it('offers the command-only fields with the default patterns', async () => {
      await open({});
      click(addButton('+ Añadir comando'));
      expect(dialog().open).toBe(true);
      expect(el('cmd-only-fields').style.display).toBe('');
      expect(el('sf-inherit-group-env-row').style.display).toBe('none');
      expect(el('sf-timeout-row').style.display).toBe('none');
      expect(el<HTMLElement>('sf-schedule-group').style.display).toBe('');
      expect(input('sf-icon-btn').textContent).toBe('⚙️');
      expect(input('sf-warn').value).toContain('warn');
      expect(input('sf-error').value).toContain('error');
    });

    it('fills every field from the command being edited', async () => {
      await open({
        commands: [
          command('api', {
            cwd: '/srv',
            warnRegex: 'WARN',
            errorRegex: 'ERR',
            silenceWarnings: true,
            silenceErrors: true,
            maxLogLines: 42,
            confirm: true,
            confirmSecs: 7,
            confirmOnTimeout: 'confirm',
          }),
        ],
      });
      click(editButtonIn('.sub-item-list[data-kind="command"] .sub-item-row'));
      expect(input('sf-name').value).toBe('api');
      expect(input('sf-command').value).toBe('npm');
      expect(el<HTMLTextAreaElement>('sf-args').value).toBe('run\napi');
      expect(input('sf-cwd').value).toBe('/srv');
      expect(input('sf-warn').value).toBe('WARN');
      expect(input('sf-error').value).toBe('ERR');
      expect(input('sf-silence-warn').checked).toBe(true);
      expect(input('sf-silence-err').checked).toBe(true);
      expect(input('sf-max-log-lines').value).toBe('42');
      expect(input('sf-confirm').checked).toBe(true);
      expect(input('sf-confirm-secs').value).toBe('7');
      expect(el<HTMLSelectElement>('sf-confirm-on-timeout').value).toBe(
        'confirm',
      );
      expect(el('sf-confirm-details').style.display).toBe('');
    });

    it('reveals and hides the confirmation detail with its toggle', async () => {
      await open({});
      click(addButton('+ Añadir comando'));
      expect(el('sf-confirm-details').style.display).toBe('none');
      input('sf-confirm').checked = true;
      input('sf-confirm').dispatchEvent(new Event('change'));
      expect(el('sf-confirm-details').style.display).toBe('');
      input('sf-confirm').checked = false;
      input('sf-confirm').dispatchEvent(new Event('change'));
      expect(el('sf-confirm-details').style.display).toBe('none');
    });
  });

  describe('opening for an action', () => {
    it('hides the command-only fields and offers the inherit toggle', async () => {
      await open({ actions: [action('seed', { inheritGroupEnv: true })] });
      click(editButtonIn('.sub-item-list[data-kind="action"] .sub-item-row'));
      expect(el('cmd-only-fields').style.display).toBe('none');
      expect(el('sf-inherit-group-env-row').style.display).toBe('');
      expect(input('sf-inherit-group-env').checked).toBe(true);
      expect(el<HTMLElement>('sf-schedule-group').style.display).toBe('');
    });

    it('starts a new action with the wand icon', async () => {
      await open({});
      click(addButton('+ Añadir acción'));
      expect(input('sf-icon-btn').textContent).toBe('🪄');
      expect(input('sf-inherit-group-env').checked).toBe(false);
    });
  });

  describe('opening for a pre-script', () => {
    it('offers the timeout and hides the icon and the schedule', async () => {
      await open({ preScripts: [preScript('seed', { timeoutMs: 90_000 })] });
      click(editButtonIn('.prescript-row'));
      expect(el('sf-timeout-row').style.display).toBe('');
      expect(input('sf-timeout-secs').value).toBe('90');
      expect(el<HTMLElement>('sf-schedule-group').style.display).toBe('none');
      expect(
        document.querySelector<HTMLElement>('.sf-icon-field')?.style.display,
      ).toBe('none');
    });

    it('leaves the timeout blank when the script has none', async () => {
      await open({});
      click(addButton('+ Añadir pre-script'));
      expect(input('sf-timeout-secs').value).toBe('');
    });
  });

  describe('saving', () => {
    it('writes a command, keeping what the dialog never shows', async () => {
      const w = await open({
        commands: [
          command('api', {
            autoStart: true,
            silencedPatterns: { warn: ['w'], error: ['e'] },
          }),
        ],
      });
      click(editButtonIn('.sub-item-list[data-kind="command"] .sub-item-row'));
      input('sf-name').value = '  api-2  ';
      el<HTMLTextAreaElement>('sf-args').value = ' run \n\n dev ';
      input('sf-max-log-lines').value = '500';
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(dialog().open).toBe(false);
      const body = payload(saves);
      expect(body.name).toBe('api-2');
      expect(body.args).toEqual(['run', 'dev']);
      expect(body.maxLogLines).toBe(500);
      expect(body.autoStart, 'the list owns the auto-start flag').toBe(true);
      expect(body.silencedPatterns).toEqual({ warn: ['w'], error: ['e'] });
      await w.settle('saveCommand', command('api'));
      await w.settle('listGroups', [group('api')]);
      expect(toastText()).toBe('Comando guardado');
    });

    it('defaults a brand-new command and blanks an empty limit', async () => {
      await open({});
      click(addButton('+ Añadir comando'));
      input('sf-name').value = 'web';
      input('sf-command').value = 'pnpm';
      const saves = recordApiCalls('saveCommand');
      submit();
      const body = payload(saves);
      expect(body.id).toBeUndefined();
      expect(body.maxLogLines).toBeNull();
      expect(body.cwd).toBeNull();
      expect(body.autoStart).toBe(false);
      expect(body.silencedPatterns).toEqual({ warn: [], error: [] });
    });

    it('falls back to the default patterns when they are cleared', async () => {
      await open({});
      click(addButton('+ Añadir comando'));
      input('sf-warn').value = '';
      input('sf-error').value = '';
      const saves = recordApiCalls('saveCommand');
      submit();
      const body = payload(saves);
      expect(body.warnRegex).toContain('warn');
      expect(body.errorRegex).toContain('error');
    });

    it('writes an action and says so in the feminine', async () => {
      const w = await open({});
      click(addButton('+ Añadir acción'));
      input('sf-name').value = 'seed';
      input('sf-inherit-group-env').checked = true;
      const saves = recordApiCalls('saveAction');
      submit();
      expect(payload(saves).inheritGroupEnv).toBe(true);
      await w.settle('saveAction', action('seed'));
      await w.settle('listGroups', [group('api')]);
      expect(toastText()).toBe('Acción guardada');
    });

    it('writes a pre-script in milliseconds and refreshes the pipeline', async () => {
      const w = await open({});
      await w.settle('getPreSteps', []); // the pipeline read the window boots with
      click(addButton('+ Añadir pre-script'));
      input('sf-name').value = 'seed';
      input('sf-timeout-secs').value = '30';
      const saves = recordApiCalls('savePreScript');
      submit();
      expect(payload(saves).timeoutMs).toBe(30_000);
      await w.settle('savePreScript', preScript('seed'));
      await w.settle('listGroups', [group('api')]);
      await w.settle('getPreSteps', []);
      expect(toastText()).toBe('Pre-script guardado');
    });

    it('sends a null timeout when the field is empty', async () => {
      await open({});
      click(addButton('+ Añadir pre-script'));
      const saves = recordApiCalls('savePreScript');
      submit();
      expect(payload(saves).timeoutMs).toBeNull();
      expect(payload(saves).confirmSecs).toBeNull();
    });

    it('records the schedule the editor is showing', async () => {
      await open({});
      click(addButton('+ Añadir comando'));
      input('sf-schedule-enabled').checked = true;
      document
        .querySelector<HTMLElement>('#sf-schedule-rules .day-chip')
        ?.click();
      const saves = recordApiCalls('saveCommand');
      submit();
      expect(payload(saves).schedule).toEqual({
        enabled: true,
        rules: [{ time: '09:00', days: [1] }],
      });
    });

    it('surfaces a save that blew up', async () => {
      const w = await open({});
      click(addButton('+ Añadir comando'));
      submit();
      await w.fail('saveCommand', new Error('disk full'));
      expect(toastText()).toBe('Error: disk full');
    });

    it('keeps the open group on screen when main stops listing it', async () => {
      const w = await open({});
      click(addButton('+ Añadir comando'));
      submit();
      await w.settle('saveCommand', command('api'));
      await w.settle('listGroups', []);
      // Nothing to merge, so the pane re-renders the draft it still holds
      // rather than blanking the editor under the user.
      expect(
        document.querySelector<HTMLInputElement>('.detail-name-input')?.value,
      ).toBe('api');
    });
  });

  describe('dialog chrome', () => {
    it('closes on cancel without saving', async () => {
      const w = await open({});
      click(addButton('+ Añadir comando'));
      click(el('sub-cancel'));
      expect(dialog().open).toBe(false);
      expect(w.callCount('saveCommand')).toBe(0);
    });

    it('picks an icon through the shared picker', async () => {
      const w = await open({});
      await w.settle('getIconBattery', [
        { emoji: '🚀', label: 'rocket', group: 'Objects', keywords: [] },
      ]);
      click(addButton('+ Añadir comando'));
      click(el('sf-icon-btn'));
      expect(document.getElementById('icon-picker')?.parentElement).toBe(
        dialog(),
      );
      click(document.querySelector('#icon-picker .icon-cell'));
      expect(el('sf-icon-btn').textContent).toBe('🚀');
    });

    it('writes the chosen folder into the cwd field', async () => {
      const w = await open({});
      click(addButton('+ Añadir comando'));
      click(el('sf-cwd-pick'));
      await w.settle('pickFolder', { ok: true, path: '/srv/api' });
      expect(input('sf-cwd').value).toBe('/srv/api');
    });

    it('leaves the cwd field alone when the picker is cancelled', async () => {
      const w = await open({});
      click(addButton('+ Añadir comando'));
      click(el('sf-cwd-pick'));
      await w.settle('pickFolder', { canceled: true });
      expect(input('sf-cwd').value).toBe('');
    });

    it('surfaces a refused folder dialog and ignores an empty answer', async () => {
      const w = await open({});
      click(addButton('+ Añadir comando'));
      click(el('sf-cwd-pick'));
      await w.settle('pickFolder', { ok: false, error: 'no access' });
      expect(toastText()).toBe('Error: no access');
      click(el('sf-cwd-pick'));
      await w.settle('pickFolder', { ok: true });
      expect(input('sf-cwd').value).toBe('');
    });
  });
});
