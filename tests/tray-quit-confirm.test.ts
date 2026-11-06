// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import type { CommandRuntimeState, GroupState } from '../src/ipc-contract.js';
import type { ProcessStatus } from '../src/domain-types.js';

/**
 * «¿Salir de DevBar?», what the tray's power button opens instead of quitting
 * at once (renderer/tray/quit-confirm.ts), driven through the real tray
 * window: what it says about the running services, that only its own «Salir»
 * quits, the ways out, and where focus goes.
 *
 * jsdom ships `<dialog>` with `open` but none of its methods. The stubs keep
 * `open` as the single source of truth and, like a browser, fire `close` a
 * task AFTER `close()` — the gap the module has to survive.
 */
function stubDialogMethods(): void {
  const proto = window.HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
}

function groupState(
  name: string,
  statuses: ProcessStatus[],
  overrides: Partial<GroupState['group']> = {},
): GroupState {
  const commands: CommandRuntimeState[] = statuses.map((status, i) => ({
    ports: [],
    commandId: `${name}-c${i}`,
    processId: `${name}-p${i}`,
    status,
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: null,
    color: 'stopped',
    muteWarn: false,
    muteErr: false,
  }));
  return {
    groupId: `group-${name}`,
    group: {
      id: `group-${name}`,
      name,
      icon: 'package',
      iconColor: null,
      path: '',
      mode: 'single',
      order: 0,
      silenceWarnings: false,
      silenceErrors: false,
      env: [],
      commands: [],
      actions: [],
      preScripts: [],
      waitForPipeline: true,
      hiddenInTray: false,
      ...overrides,
    },
    currentBranch: null,
    color: 'stopped',
    commands,
    actions: [],
    lastError: null,
  };
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}
const squash = (node: Node | null | undefined): string =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const dialog = (): HTMLDialogElement => byId<HTMLDialogElement>('quit-dialog');
const power = (): HTMLButtonElement => byId<HTMLButtonElement>('quit-app');
/** The browser's Escape: a cancelable `cancel` on the dialog. */
const pressEscape = (): void => {
  dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
};
/** Lets the queued `close` event (and anything it wakes) run. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
/** Lets the one-frame resize debounce actually run. */
async function nextFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe('renderer/tray/quit-confirm.ts', () => {
  let tray: RendererWindow | null = null;
  const quit = vi.fn();

  beforeEach(() => {
    stubDialogMethods();
    quit.mockReset();
  });

  afterEach(() => {
    tray?.close();
    tray = null;
  });

  async function openTray(states: GroupState[] = []): Promise<RendererWindow> {
    tray = await loadRendererWindow({
      html: 'tray.html',
      load: () => import('../renderer/tray.js'),
      values: { platform: 'macos', quit },
    });
    await tray.settle('getGroupStates', states);
    return tray;
  }

  describe('opening', () => {
    it('asks first: the power button opens the dialog and quits nothing', async () => {
      await openTray();

      click(power());

      expect(dialog().open).toBe(true);
      expect(squash(dialog().querySelector('h2'))).toBe('¿Salir de DevBar?');
      expect(quit).not.toHaveBeenCalled();
    });

    it('offers «Cancelar» and a destructive «Salir», with focus on «Salir»', async () => {
      await openTray();

      click(power());

      expect(squash(byId('quit-cancel'))).toBe('Cancelar');
      expect(squash(byId('quit-confirm'))).toBe('Salir');
      expect(byId('quit-confirm').classList.contains('danger')).toBe(true);
      expect(document.activeElement).toBe(byId('quit-confirm'));
    });

    it('is the shared in-window modal, labelled by its title and note', async () => {
      await openTray();

      expect(dialog().classList.contains('modal')).toBe(true);
      const title = dialog().getAttribute('aria-labelledby') ?? '';
      const note = dialog().getAttribute('aria-describedby') ?? '';
      expect(squash(byId(title))).toBe('¿Salir de DevBar?');
      expect(byId(note)).toBe(byId('quit-dialog-note'));
    });
  });

  describe('the running services it mentions', () => {
    it('counts the running services across every group', async () => {
      await openTray([
        groupState('api', ['running', 'stopped']),
        groupState('web', ['running']),
      ]);

      click(power());

      expect(squash(byId('quit-dialog-note'))).toBe(
        'Se pararán 2 servicios en marcha.',
      );
    });

    it('speaks in the singular for one', async () => {
      await openTray([groupState('api', ['running'])]);

      click(power());

      expect(squash(byId('quit-dialog-note'))).toBe(
        'Se parará 1 servicio en marcha.',
      );
    });

    it('says so when nothing is running', async () => {
      await openTray([groupState('api', ['stopped', 'error', 'done'])]);

      click(power());

      expect(squash(byId('quit-dialog-note'))).toBe(
        'No hay ningún servicio en marcha.',
      );
    });

    it('counts one still starting, and one in a group hidden from the tray', async () => {
      await openTray([
        groupState('api', ['starting']),
        groupState('oculto', ['running'], { hiddenInTray: true }),
      ]);

      click(power());

      expect(squash(byId('quit-dialog-note'))).toBe(
        'Se pararán 2 servicios en marcha.',
      );
    });

    it('follows a state push while open, without rebuilding its buttons', async () => {
      const win = await openTray([groupState('api', ['running'])]);
      click(power());
      const confirm = byId('quit-confirm');
      const cancel = byId('quit-cancel');

      await win.push('onUpdate', [groupState('api', ['running', 'running'])]);

      expect(squash(byId('quit-dialog-note'))).toBe(
        'Se pararán 2 servicios en marcha.',
      );
      expect(byId('quit-confirm')).toBe(confirm);
      expect(byId('quit-cancel')).toBe(cancel);
      expect(dialog().open).toBe(true);
    });
  });

  describe('confirming', () => {
    it('quits once on «Salir»', async () => {
      await openTray();
      click(power());

      click(byId('quit-confirm'));
      await drain();

      expect(quit).toHaveBeenCalledTimes(1);
      expect(dialog().open).toBe(false);
    });

    it('leaves focus alone after quitting', async () => {
      await openTray();
      click(power());

      click(byId('quit-confirm'));
      await drain();

      expect(document.activeElement).not.toBe(power());
    });
  });

  describe('cancelling', () => {
    it('does nothing on «Cancelar», and gives focus back to the power button', async () => {
      await openTray();
      click(power());

      click(byId('quit-cancel'));
      await drain();

      expect(dialog().open).toBe(false);
      expect(quit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(power());
    });

    it('closes on Escape without quitting', async () => {
      await openTray();
      click(power());

      pressEscape();
      await drain();

      expect(dialog().open).toBe(false);
      expect(quit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(power());
    });

    it('closes on a click outside, without quitting', async () => {
      await openTray();
      click(power());

      // A click whose target is the dialog itself fell on the backdrop.
      click(dialog());
      await drain();

      expect(dialog().open).toBe(false);
      expect(quit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(power());
    });

    it('goes away with the popover, so the next show does not ask again', async () => {
      await openTray();
      click(power());

      // The popover hides when it loses focus.
      window.dispatchEvent(new Event('blur'));
      await drain();

      expect(dialog().open).toBe(false);
      expect(quit).not.toHaveBeenCalled();
    });

    it('ignores the previous close when reopened before it lands', async () => {
      await openTray();
      click(power());
      click(byId('quit-cancel'));

      // Reopened in the gap before the browser fires the first `close`.
      click(power());
      await drain();

      expect(dialog().open).toBe(true);
      expect(document.activeElement).toBe(byId('quit-confirm'));
    });

    it('still quits from a reopened dialog after an earlier cancel', async () => {
      await openTray();
      click(power());
      click(byId('quit-cancel'));
      await drain();

      click(power());
      click(byId('quit-confirm'));
      await drain();

      expect(quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('the popover height', () => {
    it('grows the popover to fit the dialog while it is open, and lets it go after', async () => {
      const win = await openTray();
      // jsdom has no layout: stand in for the dialog's rendered height.
      Object.defineProperty(dialog(), 'offsetHeight', {
        configurable: true,
        get: () => 180,
      });
      await nextFrame();

      click(power());
      await nextFrame();
      const open = win.argsFor('setTrayHeight').at(-1)?.[0] as number;

      click(byId('quit-cancel'));
      await drain();
      await nextFrame();
      const closed = win.argsFor('setTrayHeight').at(-1)?.[0] as number;

      expect(open).toBeGreaterThan(180);
      expect(closed).toBeLessThan(180);
    });
  });
});
