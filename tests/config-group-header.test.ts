// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { iconText } from './helpers/icon-text.js';
import { tipOf } from './helpers/tip.js';
import {
  command,
  group,
  openConfigWindow,
  recordApiCalls,
} from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type { Group, ProcessStatus } from '../src/domain-types.js';
import type { GroupState } from '../src/ipc-contract.js';

/**
 * The group's header: who it is (icon, name, folder, branch), whether it is
 * running, whether the tray shows it, and the group-wide actions behind «⋯».
 */

function header(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '#group-detail .detail-header',
  );
  if (!el) throw new Error('the detail pane drew no header');
  return el;
}

function pill(): HTMLElement {
  const el = header().querySelector<HTMLElement>('.detail-status');
  if (!el) throw new Error('the header has no status pill');
  return el;
}

function moreButton(): HTMLButtonElement {
  const el = header().querySelector<HTMLButtonElement>('.detail-more');
  if (!el) throw new Error('the header has no «⋯» button');
  return el;
}

function menuItem(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#group-detail [role="menuitem"]',
    ),
  ].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no menu item "${label}"`);
  return found;
}

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The slice of a runtime snapshot the header reads. */
function state(
  groupId: string,
  options: {
    branch?: string | null;
    commands?: Array<[string, ProcessStatus]>;
    actions?: Array<[string, ProcessStatus]>;
  } = {},
): GroupState {
  return {
    groupId,
    currentBranch: options.branch ?? null,
    commands: (options.commands ?? []).map(([commandId, status]) => ({
      commandId,
      status,
    })),
    actions: (options.actions ?? []).map(([actionId, status]) => ({
      actionId,
      status,
    })),
  } as unknown as GroupState;
}

describe('renderer/config/group-header.ts', () => {
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

  describe('identity', () => {
    it('shows the folder under the name', async () => {
      await open();
      expect(iconText(header().querySelector('.detail-path'))).toBe(
        '[folder]/tmp/api',
      );
    });

    it('adds the current branch once main reports it', async () => {
      const w = await open();
      expect(header().querySelector('.detail-branch')).toBeNull();
      await w.settle('getGroupStates', [
        state('group-api', { branch: 'main' }),
      ]);
      expect(iconText(header().querySelector('.detail-branch'))).toBe(
        '[git-branch]main',
      );
    });

    it('leaves the branch out when the folder is not a repository', async () => {
      const w = await open();
      await w.settle('getGroupStates', [state('group-api', { branch: null })]);
      expect(header().querySelector('.detail-branch')).toBeNull();
    });
  });

  describe('status pill', () => {
    it('reads «Parado» while nothing runs', async () => {
      const w = await open({ commands: [command('web')] });
      await w.settle('getGroupStates', [
        state('group-api', { commands: [['cmd-web', 'stopped']] }),
      ]);
      expect(pill().textContent).toBe('Parado');
      expect(pill().classList.contains('is-running')).toBe(false);
    });

    it('counts the commands and actions in progress', async () => {
      const w = await open();
      await w.settle('getGroupStates', [
        state('group-api', {
          commands: [
            ['cmd-web', 'running'],
            ['cmd-worker', 'starting'],
            ['cmd-db', 'stopped'],
          ],
          actions: [['act-seed', 'running']],
        }),
      ]);
      expect(pill().textContent).toBe('3 en marcha');
      expect(pill().classList.contains('is-running')).toBe(true);
    });

    it('follows live updates even while the pane has unsaved edits', async () => {
      const w = await open();
      const name =
        document.querySelector<HTMLInputElement>('.detail-name-input');
      name!.value = 'api-2';
      name!.dispatchEvent(new Event('input'));
      await w.push('onUpdate', [
        state('group-api', { commands: [['cmd-web', 'running']] }),
      ]);
      expect(pill().textContent).toBe('1 en marcha');
      expect(name!.value).toBe('api-2');
    });
  });

  describe('visibility', () => {
    it('is an eye button named after what it shows', async () => {
      await open();
      const eye =
        header().querySelector<HTMLButtonElement>('.detail-visibility');
      expect(iconText(eye)).toBe('[eye]');
      expect(eye?.getAttribute('aria-label')).toBe('Visible en la barra');
      expect(tipOf(eye)).toBe('Ocultar de la barra');
    });
  });

  describe('«⋯» menu', () => {
    it('opens with the group-wide actions', async () => {
      await open();
      click(moreButton());
      expect(moreButton().getAttribute('aria-expanded')).toBe('true');
      expect(menuItem('Duplicar')).toBeTruthy();
      expect(menuItem('Borrar grupo…')).toBeTruthy();
    });

    it('duplicates the group as a new one that starts nothing on its own', async () => {
      const w = await open({
        commands: [command('web', { autoStart: true })],
      });
      const saves = recordApiCalls('saveGroup');
      click(moreButton());
      click(menuItem('Duplicar'));
      const copy = saves.at(-1)?.[0] as Partial<Group>;
      expect(copy.id).toBeUndefined();
      expect(copy.name).toBe('api (copia)');
      expect(copy.commands?.[0]?.autoStart).toBe(false);
      await w.settle('saveGroup', {
        ...group('api-copy'),
        name: 'api (copia)',
      });
      await w.settle('listGroups', [
        group('api'),
        { ...group('api-copy'), name: 'api (copia)' },
      ]);
      expect(
        document.querySelector<HTMLInputElement>('.detail-name-input')?.value,
      ).toBe('api (copia)');
    });

    it('deletes the group after confirming', async () => {
      const w = await open();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      click(moreButton());
      click(menuItem('Borrar grupo…'));
      expect(w.argsFor('deleteGroup')).toEqual([['group-api']]);
    });

    it('keeps the group when the user backs out', async () => {
      const w = await open();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      click(moreButton());
      click(menuItem('Borrar grupo…'));
      expect(w.callCount('deleteGroup')).toBe(0);
    });
  });
});
