// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { installJsdomGaps } from './helpers/logs-dom.js';
import type { PrescriptConfirmContext } from '../src/ipc-contract.js';

/**
 * `renderer/prescript-confirm.ts` is the gate in front of a pre-script: it
 * asks main what it is being asked to run, then sends back one answer — and
 * exactly one, however many ways the reader finds to give it. The countdown on
 * the default button is the interesting part: it is also a way for the window
 * to answer, so it has to stop the moment a human does.
 */
function context(
  overrides: Partial<PrescriptConfirmContext> = {},
): PrescriptConfirmContext {
  return {
    name: 'migrar',
    command: 'pnpm db:migrate',
    secs: null,
    onTimeout: 'cancel',
    logo: null,
    groupName: null,
    ...overrides,
  };
}

describe('renderer/prescript-confirm.ts', () => {
  let win: RendererWindow | null = null;
  let closed: number;

  beforeEach(() => {
    closed = 0;
    // jsdom refuses to close the top-level window; the window under test calls
    // it whenever it has nothing to ask about.
    Object.defineProperty(window, 'close', {
      configurable: true,
      value: () => {
        closed += 1;
      },
    });
  });

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  async function openGate(search: string): Promise<RendererWindow> {
    installJsdomGaps();
    window.history.replaceState({}, '', search);
    const opened = await loadRendererWindow({
      html: 'prescript-confirm.html',
      load: () => import('../renderer/prescript-confirm.js'),
      values: { platform: 'macos' },
    });
    win = opened;
    // `theme.ts` reads the settings at import; the gate itself does not.
    await opened.settle('getSettings', { theme: 'auto' });
    return opened;
  }

  function byId(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }

  describe('what it asks about', () => {
    it('names the script and shows the command it would run', async () => {
      const gate = await openGate('?token=t1');
      expect(gate.argsFor('getPrescriptConfirmContext')).toEqual([['t1']]);
      await gate.settle('getPrescriptConfirmContext', context());
      expect(byId('pc-title').textContent).toBe('¿Ejecutar «migrar»?');
      expect(byId('pc-cmd').textContent).toBe('pnpm db:migrate');
    });

    it('qualifies the name with the group, since two groups may share it', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle(
        'getPrescriptConfirmContext',
        context({ groupName: 'Back' }),
      );
      const group = byId('pc-group');
      expect(group.textContent).toBe('Back');
      expect(group.style.display).toBe('');
    });

    it('drops the qualifier when there is no group behind the script', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context());
      expect(byId('pc-group').style.display).toBe('none');
    });

    it('shows the logo it was handed', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle(
        'getPrescriptConfirmContext',
        context({ logo: 'data:image/png;base64,AAA' }),
      );
      expect((byId('pc-logo') as HTMLImageElement).src).toBe(
        'data:image/png;base64,AAA',
      );
    });

    it('hides the logo slot when there is none', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context({ logo: null }));
      expect(byId('pc-logo').style.display).toBe('none');
    });

    it('closes itself when it was opened without a token', async () => {
      const gate = await openGate('/');
      expect(closed).toBe(1);
      expect(gate.callCount('getPrescriptConfirmContext')).toBe(0);
    });

    it('closes itself when main no longer knows the token', async () => {
      const gate = await openGate('?token=caducado');
      await gate.settle('getPrescriptConfirmContext', null);
      expect(closed).toBe(1);
    });
  });

  describe('the answer it sends back', () => {
    it('confirms from the confirm button', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context());
      byId('pc-btn-confirm').click();
      expect(gate.argsFor('resolvePrescriptConfirm')).toEqual([
        ['t1', 'confirm'],
      ]);
    });

    it('cancels from the cancel button', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context());
      byId('pc-btn-cancel').click();
      expect(gate.argsFor('resolvePrescriptConfirm')).toEqual([
        ['t1', 'cancel'],
      ]);
    });

    it('takes Enter as yes and Escape as no', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context());
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(gate.argsFor('resolvePrescriptConfirm')).toEqual([
        ['t1', 'confirm'],
      ]);
    });

    it('ignores a key that means neither', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context());
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      expect(gate.callCount('resolvePrescriptConfirm')).toBe(0);
    });

    it('answers once, however many times it is pressed', async () => {
      const gate = await openGate('?token=t1');
      await gate.settle('getPrescriptConfirmContext', context());
      byId('pc-btn-confirm').click();
      byId('pc-btn-cancel').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(gate.argsFor('resolvePrescriptConfirm')).toEqual([
        ['t1', 'confirm'],
      ]);
    });

    it('sends nothing at all without a token to answer for', async () => {
      const gate = await openGate('/');
      byId('pc-btn-confirm').click();
      expect(gate.callCount('resolvePrescriptConfirm')).toBe(0);
    });
  });

  describe('the countdown on the default button', () => {
    /**
     * Only the interval is faked. `loadRendererWindow` and every `settle`
     * drain the microtask queue through a real `setTimeout(0)`, so faking that
     * too would hang the window before it ever asked its question.
     */
    async function openWithCountdown(
      secs: number | null,
      onTimeout: 'confirm' | 'cancel' = 'cancel',
    ): Promise<RendererWindow> {
      const gate = await openGate('?token=t1');
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await gate.settle(
        'getPrescriptConfirmContext',
        context({ secs, onTimeout }),
      );
      return gate;
    }

    it('counts down on the button the timeout would press', async () => {
      await openWithCountdown(3, 'confirm');
      const confirm = byId('pc-btn-confirm');
      expect(confirm.textContent).toBe('Ejecutar (3s)');
      expect(byId('pc-btn-cancel').textContent?.trim()).toBe('Cancelar');
      vi.advanceTimersByTime(1000);
      expect(confirm.textContent).toBe('Ejecutar (2s)');
    });

    it('counts down on the cancel button when that is the default', async () => {
      await openWithCountdown(2, 'cancel');
      expect(byId('pc-btn-cancel').textContent).toBe('Cancelar (2s)');
      expect(byId('pc-btn-confirm').textContent?.trim()).toBe('Ejecutar');
    });

    it('stops at zero and leaves the plain label behind', async () => {
      await openWithCountdown(1, 'cancel');
      const cancel = byId('pc-btn-cancel');
      vi.advanceTimersByTime(1000);
      expect(cancel.textContent).toBe('Cancelar');
      vi.advanceTimersByTime(5000);
      expect(cancel.textContent).toBe('Cancelar');
    });

    it('leaves both labels alone when nothing will time out', async () => {
      await openWithCountdown(null);
      vi.advanceTimersByTime(3000);
      expect(byId('pc-btn-cancel').textContent?.trim()).toBe('Cancelar');
      expect(byId('pc-btn-confirm').textContent?.trim()).toBe('Ejecutar');
    });

    it('stops counting the moment a human answers', async () => {
      const gate = await openWithCountdown(9, 'cancel');
      const cancel = byId('pc-btn-cancel');
      byId('pc-btn-confirm').click();
      const frozen = cancel.textContent;
      vi.advanceTimersByTime(3000);
      expect(cancel.textContent).toBe(frozen);
      expect(gate.callCount('resolvePrescriptConfirm')).toBe(1);
    });
  });
});
