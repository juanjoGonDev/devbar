// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flush, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  RemoteDeviceRow,
  RemotePairRequest,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * The «Control remoto» section of the config window, driven through the real
 * window (config.html + config.ts) with a hand-driven `window.api`: what the
 * user sees for each status main reports, and what each control asks main.
 */

const HOUR = 60 * 60_000;
const QR = {
  size: 3,
  modules: [true, false, true, false, true, false, true, false, true],
};

function status(extra: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: false,
    autoUnlink: true,
    port: 47821,
    listening: false,
    error: null,
    addresses: ['192.168.1.20'],
    devices: [],
    ...extra,
  };
}

function device(extra: Partial<RemoteDeviceRow> = {}): RemoteDeviceRow {
  return {
    id: 'd1',
    name: 'iPhone de Ana',
    client: 'Safari · iOS',
    createdAt: Date.UTC(2026, 9, 1, 10),
    lastSeenAt: Date.now(),
    connected: false,
    ...extra,
  };
}

const ON = { enabled: true, listening: true };

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}
const text = (id: string): string => el(id).textContent?.trim() ?? '';
const dialogOpen = (id: string): boolean => el<HTMLDialogElement>(id).open;
const click = (target: Element | null): void => {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('#remote-devices > li'),
];

async function openWith(initial: RemoteStatus): Promise<RendererWindow> {
  const win = await openConfigWindow();
  await win.settle('getRemoteStatus', initial);
  return win;
}

function pairRequest(
  extra: Partial<RemotePairRequest> = {},
): RemotePairRequest {
  return {
    requestId: 'r1',
    name: 'iPhone de Ana',
    client: 'Safari · iOS',
    ip: '192.168.1.40',
    verificationCode: '482913',
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

describe('renderer/config/remote-pane.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  describe('the switch card', () => {
    it('shows the switch off, with no address and adding disabled', async () => {
      win = await openWith(status());

      expect(el<HTMLInputElement>('remote-enabled').checked).toBe(false);
      expect(el<HTMLInputElement>('remote-enabled').disabled).toBe(false);
      expect(el('remote-endpoint').hidden).toBe(true);
      expect(el<HTMLButtonElement>('remote-add-device').disabled).toBe(true);
    });

    it('shows the address and the active state while listening', async () => {
      win = await openWith(status(ON));

      expect(el<HTMLInputElement>('remote-enabled').checked).toBe(true);
      expect(el('remote-endpoint').hidden).toBe(false);
      expect(text('remote-state')).toBe('Activo');
      expect(text('remote-address')).toBe('192.168.1.20:47821');
      expect(el<HTMLButtonElement>('remote-add-device').disabled).toBe(false);
    });

    it('says when there is no local network, and cannot add then', async () => {
      win = await openWith(status({ ...ON, addresses: [] }));

      expect(text('remote-address')).toBe('Sin red local');
      expect(el<HTMLButtonElement>('remote-add-device').disabled).toBe(true);
    });

    it('shows a listen error inline', async () => {
      win = await openWith(
        status({ enabled: true, error: 'El puerto 47821 ya está en uso.' }),
      );

      expect(text('remote-state')).toBe('Desactivado');
      expect(el('remote-error').hidden).toBe(false);
      expect(text('remote-error')).toBe('El puerto 47821 ya está en uso.');
    });

    it('asks main to start the server and paints what it answers', async () => {
      win = await openWith(status());
      const toggle = el<HTMLInputElement>('remote-enabled');

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      expect(toggle.disabled).toBe(true);
      await win.settle('setRemoteEnabled', status(ON));

      expect(win.argsFor('setRemoteEnabled')).toEqual([[true]]);
      expect(toggle.disabled).toBe(false);
      expect(text('remote-state')).toBe('Activo');
    });

    it('puts the switch back when main fails', async () => {
      win = await openWith(status());
      const toggle = el<HTMLInputElement>('remote-enabled');

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await win.fail('setRemoteEnabled', new Error('boom'));

      expect(toggle.checked).toBe(false);
      expect(text('toast')).toContain('boom');
    });

    it('repaints on every push from main', async () => {
      win = await openWith(status());

      await win.push('onRemoteChanged', status(ON));

      expect(text('remote-state')).toBe('Activo');
    });

    it('reports a failed first read', async () => {
      win = await openConfigWindow();

      await win.fail('getRemoteStatus', new Error('store locked'));

      expect(text('toast')).toContain('store locked');
      expect(el<HTMLInputElement>('remote-enabled').disabled).toBe(true);
    });
  });

  describe('the security card', () => {
    it('saves the auto-unlink switch', async () => {
      win = await openWith(status());
      const toggle = el<HTMLInputElement>('remote-auto-unlink');
      expect(toggle.checked).toBe(true);

      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      await win.settle('setRemoteAutoUnlink', status({ autoUnlink: false }));

      expect(win.argsFor('setRemoteAutoUnlink')).toEqual([[false]]);
      expect(toggle.checked).toBe(false);
    });
  });

  describe('the device list', () => {
    it('shows the empty state when nothing is linked', async () => {
      win = await openWith(status(ON));

      expect(text('remote-device-count')).toBe('0');
      expect(el('remote-devices-empty').hidden).toBe(false);
      expect(rows()).toEqual([]);
    });

    it('lists each device with its client, link date and presence', async () => {
      win = await openWith(
        status({
          ...ON,
          devices: [
            device({ connected: true }),
            device({
              id: 'd2',
              name: 'iPad',
              lastSeenAt: Date.now() - 3 * HOUR,
            }),
          ],
        }),
      );

      expect(text('remote-device-count')).toBe('2');
      expect(el('remote-devices-empty').hidden).toBe(true);
      const [first, second] = rows();
      expect(first?.querySelector('.remote-device-name')?.textContent).toBe(
        'iPhone de Ana',
      );
      expect(first?.querySelector('.remote-device-meta')?.textContent).toMatch(
        /^Safari · iOS · vinculado el 1 oct\.? 2026$/,
      );
      expect(first?.querySelector('.remote-seen')?.textContent).toBe(
        'Conectado ahora',
      );
      expect(second?.querySelector('.remote-seen')?.textContent).toBe(
        'Última conexión hace 3 h',
      );
    });

    it('counts as connected only a device with an open stream', async () => {
      win = await openWith(status({ ...ON, devices: [device()] }));

      expect(rows()[0]?.querySelector('.remote-seen')?.textContent).toBe(
        'Última conexión hace un momento',
      );
      expect(
        rows()[0]
          ?.querySelector('.remote-seen')
          ?.classList.contains('is-online'),
      ).toBe(false);
    });

    it('unlinks a device', async () => {
      win = await openWith(status({ ...ON, devices: [device()] }));

      click(rows()[0]?.querySelector('.remote-unlink') ?? null);
      await win.settle('unlinkRemoteDevice', { ok: true });

      expect(win.argsFor('unlinkRemoteDevice')).toEqual([['d1']]);
      expect(text('toast')).toContain('iPhone de Ana');
    });

    it('reports an unlink main refused', async () => {
      win = await openWith(status({ ...ON, devices: [device()] }));

      click(rows()[0]?.querySelector('.remote-unlink') ?? null);
      await win.settle('unlinkRemoteDevice', {
        ok: false,
        error: 'Ese dispositivo ya no está vinculado.',
      });

      expect(text('toast')).toBe('Ese dispositivo ya no está vinculado.');
    });

    describe('rename', () => {
      const startRename = (): HTMLInputElement => {
        click(rows()[0]?.querySelector('.remote-rename-btn') ?? null);
        const input = rows()[0]?.querySelector('input');
        if (!input) throw new Error('no rename input');
        return input;
      };
      const key = (input: HTMLInputElement, name: string) =>
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true }),
        );

      it('saves the new name on Enter', async () => {
        win = await openWith(status({ ...ON, devices: [device()] }));
        const input = startRename();
        expect(input.value).toBe('iPhone de Ana');

        input.value = '  Tablet  ';
        key(input, 'Enter');
        await win.push(
          'onRemoteChanged',
          status({ ...ON, devices: [device({ name: 'Tablet' })] }),
        );
        // Still editing until main answers: the push must not wipe the input.
        expect(rows()[0]?.querySelector('input')).not.toBeNull();
        await win.settle('renameRemoteDevice', { ok: true });

        expect(win.argsFor('renameRemoteDevice')).toEqual([['d1', 'Tablet']]);
        expect(
          rows()[0]?.querySelector('.remote-device-name')?.textContent,
        ).toBe('Tablet');
      });

      it('cancels on Escape without asking main', async () => {
        win = await openWith(status({ ...ON, devices: [device()] }));
        const input = startRename();

        input.value = 'Otro';
        key(input, 'Escape');
        await flush();

        expect(win.callCount('renameRemoteDevice')).toBe(0);
        expect(
          rows()[0]?.querySelector('.remote-device-name')?.textContent,
        ).toBe('iPhone de Ana');
      });

      it('saves once when the field loses focus after Enter', async () => {
        win = await openWith(status({ ...ON, devices: [device()] }));
        const input = startRename();

        input.value = 'Tablet';
        key(input, 'Enter');
        input.dispatchEvent(new Event('blur'));
        await win.settle('renameRemoteDevice', {
          ok: false,
          error: 'El nombre debe tener entre 1 y 40 caracteres.',
        });

        expect(win.callCount('renameRemoteDevice')).toBe(1);
        expect(text('toast')).toBe(
          'El nombre debe tener entre 1 y 40 caracteres.',
        );
      });

      it('does not ask main when the name did not change', async () => {
        win = await openWith(status({ ...ON, devices: [device()] }));
        const input = startRename();

        input.dispatchEvent(new Event('blur'));
        await flush();

        expect(win.callCount('renameRemoteDevice')).toBe(0);
        expect(rows()[0]?.querySelector('input')).toBeNull();
      });
    });
  });

  describe('the pairing dialog', () => {
    async function openPairing(): Promise<RendererWindow> {
      const opened = await openWith(status(ON));
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      click(el('remote-add-device'));
      return opened;
    }

    it('opens with a fresh QR and a five-minute countdown', async () => {
      win = await openPairing();
      expect(dialogOpen('remote-pair-dialog')).toBe(true);

      await win.settle('startRemotePairing', {
        ok: true,
        url: 'http://192.168.1.20:47821/pair?c=abc',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });

      expect(el('remote-qr').querySelector('svg')).not.toBeNull();
      expect(text('remote-pair-countdown')).toBe(
        'Caduca en 5:00 · se renueva solo',
      );
      expect(el('remote-pair-progress').style.width).toBe('100%');
    });

    it('counts down and renews the code by itself when it runs out', async () => {
      win = await openPairing();
      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });

      vi.advanceTimersByTime(60_000);
      expect(text('remote-pair-countdown')).toBe(
        'Caduca en 4:00 · se renueva solo',
      );
      expect(el('remote-pair-progress').style.width).toBe('80%');

      vi.advanceTimersByTime(4 * 60_000);
      expect(win.callCount('startRemotePairing')).toBe(2);
    });

    it('shows why a code could not be issued', async () => {
      win = await openPairing();

      await win.settle('startRemotePairing', {
        ok: false,
        error: 'Activa el control remoto para vincular dispositivos.',
      });

      expect(el('remote-pair-error').hidden).toBe(false);
      expect(text('remote-pair-error')).toBe(
        'Activa el control remoto para vincular dispositivos.',
      );
    });

    it('closes when the server stops listening', async () => {
      win = await openPairing();
      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });

      await win.push('onRemoteChanged', status({ enabled: false }));

      expect(dialogOpen('remote-pair-dialog')).toBe(false);
      expect(win.callCount('cancelRemotePairing')).toBe(1);
    });

    it('cancels a code that only arrives after the dialog was closed', async () => {
      win = await openPairing();
      click(document.querySelector('#remote-pair-dialog [data-close]'));

      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });

      expect(win.callCount('cancelRemotePairing')).toBe(2);
      expect(el('remote-qr').querySelector('svg')).toBeNull();
    });

    it('cancels the code when the dialog is closed', async () => {
      win = await openPairing();
      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });

      click(document.querySelector('#remote-pair-dialog [data-close]'));

      expect(dialogOpen('remote-pair-dialog')).toBe(false);
      expect(win.callCount('cancelRemotePairing')).toBe(1);
    });

    it('cancels the code when the page goes away with the dialog open', async () => {
      win = await openPairing();
      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });

      window.dispatchEvent(new Event('pagehide'));

      expect(win.callCount('cancelRemotePairing')).toBe(1);
    });

    it('leaves nothing to cancel when the page goes away with it closed', async () => {
      win = await openWith(status(ON));

      window.dispatchEvent(new Event('pagehide'));

      expect(win.callCount('cancelRemotePairing')).toBe(0);
    });
  });

  describe('a pairing request', () => {
    async function withRequest(): Promise<RendererWindow> {
      const opened = await openWith(status(ON));
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      click(el('remote-add-device'));
      await opened.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 5 * 60_000,
        qr: QR,
      });
      await opened.push('onRemotePairRequest', pairRequest());
      return opened;
    }

    it('asks for confirmation with the matching code', async () => {
      win = await withRequest();

      expect(dialogOpen('remote-request-dialog')).toBe(true);
      expect(text('remote-request-name')).toBe('iPhone de Ana');
      expect(text('remote-request-meta')).toBe('Safari · iOS · 192.168.1.40');
      expect(text('remote-request-code')).toBe('482 913');
      expect(text('remote-request-countdown')).toBe(
        'Se rechazará automáticamente en 1:00',
      );
      expect(el('remote-qr').classList.contains('is-used')).toBe(true);
    });

    it('links on «Vincular» and closes both dialogs once main confirms', async () => {
      win = await withRequest();

      click(el('remote-request-accept'));
      await win.settle('respondRemotePairing', { ok: true });
      await win.push('onRemotePairRequestClosed', {
        requestId: 'r1',
        outcome: 'accepted',
      });

      expect(win.argsFor('respondRemotePairing')).toEqual([['r1', true]]);
      expect(dialogOpen('remote-request-dialog')).toBe(false);
      expect(dialogOpen('remote-pair-dialog')).toBe(false);
    });

    it('rejects on «Rechazar» and shows a fresh code', async () => {
      win = await withRequest();

      click(el('remote-request-reject'));
      await win.settle('respondRemotePairing', { ok: true });
      await win.push('onRemotePairRequestClosed', {
        requestId: 'r1',
        outcome: 'rejected',
      });

      expect(win.argsFor('respondRemotePairing')).toEqual([['r1', false]]);
      expect(dialogOpen('remote-request-dialog')).toBe(false);
      expect(dialogOpen('remote-pair-dialog')).toBe(true);
      expect(win.callCount('startRemotePairing')).toBe(2);
    });

    it('treats Escape as a rejection', async () => {
      win = await withRequest();

      el('remote-request-dialog').dispatchEvent(
        new Event('cancel', { cancelable: true }),
      );
      await win.settle('respondRemotePairing', { ok: true });

      expect(win.argsFor('respondRemotePairing')).toEqual([['r1', false]]);
      expect(dialogOpen('remote-request-dialog')).toBe(false);
    });

    it('closes by itself when the request expires, without answering', async () => {
      win = await withRequest();

      vi.advanceTimersByTime(30_000);
      expect(text('remote-request-countdown')).toBe(
        'Se rechazará automáticamente en 0:30',
      );
      await win.push('onRemotePairRequestClosed', {
        requestId: 'r1',
        outcome: 'expired',
      });

      expect(dialogOpen('remote-request-dialog')).toBe(false);
      expect(win.callCount('respondRemotePairing')).toBe(0);
    });

    it('reports an answer main could not deliver', async () => {
      win = await withRequest();

      click(el('remote-request-accept'));
      await win.settle('respondRemotePairing', {
        ok: false,
        error: 'La solicitud ya no está pendiente.',
      });

      expect(text('toast')).toBe('La solicitud ya no está pendiente.');
      expect(dialogOpen('remote-request-dialog')).toBe(false);
    });
  });
});
