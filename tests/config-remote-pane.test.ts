// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flush, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  RemoteDeviceRow,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * The «Control remoto» section of the config window, driven through the real
 * window (config.html + config.ts) with a hand-driven `window.api`: what the
 * user sees for each status main reports, and what each control asks main.
 * A phone asking to be linked is tests/config-remote-request.test.ts.
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
    notifyConnections: true,
    port: 47821,
    listening: false,
    error: null,
    keyError: null,
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
    verifiedAt: null,
    lastIp: null,
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

    it('keeps the port behind a collapsed gear section', async () => {
      win = await openWith(status(ON));
      const settings = el<HTMLDetailsElement>('remote-port-settings');

      expect(settings.open).toBe(false);
      expect(settings.contains(el('remote-port'))).toBe(true);
      expect(
        settings.querySelector('summary')?.getAttribute('aria-label'),
      ).toBe('Ajustes del servicio');
      expect(text('remote-port-hint').replace(/\s+/g, ' ')).toBe(
        'Si lo cambias, tendrás que volver a añadir el acceso directo en el móvil.',
      );
    });

    it('opens the gear section when the server could not listen', async () => {
      win = await openWith(
        status({ enabled: true, error: 'El puerto 47821 ya está en uso.' }),
      );

      expect(el<HTMLDetailsElement>('remote-port-settings').open).toBe(true);
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

  describe('the port field', () => {
    const RANGE = 'El puerto debe ser un número entero entre 1024 y 65535.';
    const port = () => el<HTMLInputElement>('remote-port');
    const applyBtn = () => el<HTMLButtonElement>('remote-port-apply');
    const type = (value: string): void => {
      port().value = value;
      port().dispatchEvent(new Event('input', { bubbles: true }));
    };
    const enter = (): void => {
      port().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    };

    it('shows the port, editable with the switch off, and nothing to apply', async () => {
      win = await openWith(status());

      expect(port().value).toBe('47821');
      expect(port().disabled).toBe(false);
      expect(applyBtn().disabled).toBe(true);
      expect(el('remote-port-error').hidden).toBe(true);
    });

    it('stays locked until main reports the status', async () => {
      win = await openConfigWindow();

      expect(port().disabled).toBe(true);
      expect(applyBtn().disabled).toBe(true);
    });

    it.each([
      ['a different valid port', '50123', false],
      ['the current port', '47821', true],
      ['a privileged port', '80', true],
      ['a port past 65535', '70000', true],
      ['an empty field', '', true],
    ])('offers «Aplicar» only for %s', async (_label, value, disabled) => {
      win = await openWith(status(ON));

      type(value);

      expect(applyBtn().disabled).toBe(disabled);
    });

    it('asks main for the new port and paints what it answers', async () => {
      win = await openWith(status(ON));

      type('50123');
      click(applyBtn());
      expect(applyBtn().disabled).toBe(true);
      await win.settle('setRemotePort', {
        ok: true,
        status: status({ ...ON, port: 50123 }),
      });

      expect(win.argsFor('setRemotePort')).toEqual([[50123]]);
      expect(text('remote-address')).toBe('192.168.1.20:50123');
      expect(port().value).toBe('50123');
      expect(applyBtn().disabled).toBe(true);
    });

    it('applies with Enter', async () => {
      win = await openWith(status());

      type('50123');
      enter();
      await win.settle('setRemotePort', {
        ok: true,
        status: status({ port: 50123 }),
      });

      expect(win.argsFor('setRemotePort')).toEqual([[50123]]);
    });

    it('explains an invalid port inline without asking main', async () => {
      win = await openWith(status());

      type('80');
      enter();
      await flush();

      expect(win.callCount('setRemotePort')).toBe(0);
      expect(el('remote-port-error').hidden).toBe(false);
      expect(text('remote-port-error')).toBe(RANGE);
      expect(port().getAttribute('aria-invalid')).toBe('true');

      type('8080');
      expect(el('remote-port-error').hidden).toBe(true);
      expect(port().hasAttribute('aria-invalid')).toBe(false);
    });

    it('explains an invalid port when the field is left', async () => {
      win = await openWith(status());

      type('70000');
      port().dispatchEvent(new Event('change'));

      expect(text('remote-port-error')).toBe(RANGE);
    });

    it('shows a refusal from main inline', async () => {
      win = await openWith(status());

      type('50123');
      click(applyBtn());
      await win.settle('setRemotePort', { ok: false, error: RANGE });

      expect(text('remote-port-error')).toBe(RANGE);
      expect(applyBtn().disabled).toBe(false);
    });

    it('shows a listen failure on the new port where it always has', async () => {
      win = await openWith(status(ON));
      const taken = 'El puerto 50123 ya está en uso por otra aplicación.';

      type('50123');
      click(applyBtn());
      await win.settle('setRemotePort', {
        ok: true,
        status: status({ enabled: true, port: 50123, error: taken }),
      });

      expect(text('remote-error')).toBe(taken);
      expect(el('remote-port-error').hidden).toBe(true);
    });

    it('reports a call that failed and lets the user retry', async () => {
      win = await openWith(status());

      type('50123');
      click(applyBtn());
      await win.fail('setRemotePort', new Error('boom'));

      expect(text('toast')).toContain('boom');
      expect(applyBtn().disabled).toBe(false);
    });

    it('keeps what the user is typing across pushes from main', async () => {
      win = await openWith(status());

      type('50123');
      await win.push('onRemoteChanged', status(ON));

      expect(port().value).toBe('50123');
      expect(applyBtn().disabled).toBe(false);
    });

    it('follows a port change pushed from main while untouched', async () => {
      win = await openWith(status());

      await win.push('onRemoteChanged', status({ port: 50123 }));

      expect(port().value).toBe('50123');
      expect(applyBtn().disabled).toBe(true);
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

    it('shows the IP each device last signed in from', async () => {
      win = await openWith(
        status({
          ...ON,
          devices: [device({ lastIp: '192.168.1.57' }), device({ id: 'd2' })],
        }),
      );

      const [first, second] = rows();
      expect(first?.querySelector('.remote-device-ip')?.textContent).toBe(
        'Última IP 192.168.1.57',
      );
      expect(second?.querySelector('.remote-device-ip')).toBeNull();
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

    it('opens with a fresh QR and a thirty-second countdown', async () => {
      win = await openPairing();
      expect(dialogOpen('remote-pair-dialog')).toBe(true);

      await win.settle('startRemotePairing', {
        ok: true,
        url: 'http://192.168.1.20:47821/pair#c=abc&k=K',
        expiresAt: Date.now() + 30_000,
        qr: QR,
      });

      expect(el('remote-qr').querySelector('svg')).not.toBeNull();
      expect(text('remote-pair-countdown')).toBe(
        'Caduca en 0:30 · se renueva solo',
      );
      expect(el('remote-pair-progress').style.width).toBe('100%');
      expect(
        document.querySelector('.remote-pair-actions small')?.textContent,
      ).toBe('Un solo uso, se renueva cada 30 segundos.');
    });

    it('counts down and renews the code by itself when it runs out', async () => {
      win = await openPairing();
      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 30_000,
        qr: QR,
      });

      vi.advanceTimersByTime(6_000);
      expect(text('remote-pair-countdown')).toBe(
        'Caduca en 0:24 · se renueva solo',
      );
      expect(el('remote-pair-progress').style.width).toBe('80%');

      vi.advanceTimersByTime(24_000);
      expect(win.callCount('startRemotePairing')).toBe(2);
    });

    it('shows a fresh code the moment a phone claims the one on screen', async () => {
      win = await openPairing();
      await win.settle('startRemotePairing', {
        ok: true,
        url: 'u',
        expiresAt: Date.now() + 30_000,
        qr: QR,
      });

      await win.push('onRemotePairCodeClaimed');

      expect(win.callCount('startRemotePairing')).toBe(2);
    });

    it('asks for no code when a claim arrives with the dialog closed', async () => {
      win = await openWith(status(ON));

      await win.push('onRemotePairCodeClaimed');

      expect(win.callCount('startRemotePairing')).toBe(0);
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
});
