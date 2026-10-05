// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  RemoteDeviceRow,
  RemoteSecurityCodeResult,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * The security side of «Control remoto» in the config window: the note that
 * the connection is end-to-end encrypted, each device's «Verificado» state
 * and its «Código de seguridad» (six groups and the QR its phone scans), the
 * connection-notice switch, «Renovar clave del equipo», and what the section
 * says when this computer's key cannot be read or is kept outside the
 * keychain.
 */

const KEY_ERROR =
  'No se pudo leer la clave de seguridad del llavero del sistema. Desbloquéalo y pulsa Reintentar.';

const QR = {
  size: 3,
  modules: [true, false, true, false, true, false, true, false, true],
};
const CODE = ['12345', '67890', '13579', '24680', '11223', '34455'];

function status(extra: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    autoUnlink: true,
    notifyConnections: true,
    port: 47821,
    listening: true,
    error: null,
    keyError: null,
    keyUnsealed: false,
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

const safety = (
  extra: Partial<Extract<RemoteSecurityCodeResult, { ok: true }>> = {},
): RemoteSecurityCodeResult => ({
  ok: true,
  code: CODE,
  verified: false,
  url: 'http://192.168.1.20:47821/verify#k=K&d=d1&p=P',
  qr: QR,
  ...extra,
});

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}
const text = (id: string): string =>
  el(id).textContent?.replace(/\s+/g, ' ').trim() ?? '';
const click = (target: Element | null): void => {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const row = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#remote-devices > li');

async function openWith(initial: RemoteStatus): Promise<RendererWindow> {
  const win = await openConfigWindow();
  await win.settle('getRemoteStatus', initial);
  return win;
}

describe('«Control remoto» security (renderer/config/remote-pane.ts)', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
  });

  it('presents the encryption as a feature, with a lock, not a warning', async () => {
    win = await openWith(status());

    const note = document.querySelector('.remote-secure-note');
    const copy = note?.querySelector('span:not(.icon)')?.textContent;
    expect(copy?.replace(/\s+/g, ' ').trim()).toBe(
      'Cifrado de extremo a extremo: lo que viaja entre DevBar y tus dispositivos va cifrado, con una clave nueva en cada conexión.',
    );
    expect(note?.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(document.querySelector('.remote-warning')).toBeNull();
    expect(document.body.textContent).not.toMatch(/no va cifrada|confianza/);
  });

  describe('each device', () => {
    it('says whether it is verified', async () => {
      win = await openWith(
        status({
          devices: [
            device(),
            device({ id: 'd2', name: 'iPad', verifiedAt: Date.now() }),
          ],
        }),
      );

      const badges = [
        ...document.querySelectorAll('#remote-devices .remote-verified'),
      ].map((badge) => badge.textContent?.trim());
      expect(badges).toEqual(['Sin verificar', 'Verificado']);
      expect(
        document
          .querySelectorAll('#remote-devices .remote-verified')[1]
          ?.classList.contains('is-verified'),
      ).toBe(true);
    });

    it('opens its security code: the six groups and the QR to scan', async () => {
      win = await openWith(status({ devices: [device()] }));

      click(row()?.querySelector('.remote-safety-btn') ?? null);
      await win.settle('getRemoteSecurityCode', safety());

      expect(win.argsFor('getRemoteSecurityCode')).toEqual([['d1']]);
      expect(el<HTMLDialogElement>('remote-safety-dialog').open).toBe(true);
      expect(text('remote-safety-device')).toBe('iPhone de Ana');
      expect(
        [...el('remote-safety-code').children].map((g) => g.textContent),
      ).toEqual(CODE);
      expect(el('remote-safety-qr').querySelector('svg')).not.toBeNull();
      expect(el('remote-safety-qr').hidden).toBe(false);
      expect(text('remote-safety-hint')).toBe(
        'Escanéalo con la cámara del móvil para verificar que la conexión está cifrada con esta clave.',
      );
      expect(text('remote-safety-status')).toBe('Sin verificar');
    });

    it('shows the code without a QR while the server is off', async () => {
      win = await openWith(status({ devices: [device()] }));

      click(row()?.querySelector('.remote-safety-btn') ?? null);
      await win.settle(
        'getRemoteSecurityCode',
        safety({ url: null, qr: null }),
      );

      expect(el('remote-safety-qr').hidden).toBe(true);
      expect(text('remote-safety-hint')).toBe(
        'Activa el control remoto para verificarlo desde el móvil.',
      );
      expect([...el('remote-safety-code').children]).toHaveLength(6);
    });

    it('turns «Verificado» the moment the phone confirms the scan', async () => {
      win = await openWith(status({ devices: [device()] }));
      click(row()?.querySelector('.remote-safety-btn') ?? null);
      await win.settle('getRemoteSecurityCode', safety());

      await win.push(
        'onRemoteChanged',
        status({ devices: [device({ verifiedAt: Date.now() })] }),
      );

      expect(text('remote-safety-status')).toBe('Verificado');
      expect(el('remote-safety-status').classList.contains('is-verified')).toBe(
        true,
      );
    });

    it('reports a device that is gone instead of opening', async () => {
      win = await openWith(status({ devices: [device()] }));

      click(row()?.querySelector('.remote-safety-btn') ?? null);
      await win.settle('getRemoteSecurityCode', {
        ok: false,
        error: 'Ese dispositivo ya no está vinculado.',
      });

      expect(el<HTMLDialogElement>('remote-safety-dialog').open).toBe(false);
      expect(text('toast')).toBe('Ese dispositivo ya no está vinculado.');
    });
  });

  describe('the Seguridad card', () => {
    it('saves the connection-notice switch, on by default', async () => {
      win = await openWith(status());
      const toggle = el<HTMLInputElement>('remote-notify-connections');
      expect(toggle.checked).toBe(true);

      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      await win.settle(
        'setRemoteNotifyConnections',
        status({ notifyConnections: false }),
      );

      expect(win.argsFor('setRemoteNotifyConnections')).toEqual([[false]]);
      expect(toggle.checked).toBe(false);
    });

    it('renews the computer key only after a confirmation', async () => {
      win = await openWith(status());
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

      click(el('remote-renew-identity'));
      expect(win.callCount('renewRemoteIdentity')).toBe(0);

      confirm.mockReturnValue(true);
      click(el('remote-renew-identity'));
      await win.settle('renewRemoteIdentity', { ok: true });

      expect(confirm.mock.calls[0]?.[0]).toMatch(/Renovar la clave/);
      expect(win.callCount('renewRemoteIdentity')).toBe(1);
      expect(text('toast')).toBe(
        'Clave del equipo renovada. Verifica de nuevo cada dispositivo.',
      );
    });

    it('reports a renewal that failed', async () => {
      win = await openWith(status());
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      click(el('remote-renew-identity'));
      await win.fail('renewRemoteIdentity', new Error('keychain'));

      expect(text('toast')).toContain('keychain');
      expect(el<HTMLButtonElement>('remote-renew-identity').disabled).toBe(
        false,
      );
    });
  });

  describe("this computer's key", () => {
    it('says it could not be read, with «Reintentar», while the server stays off', async () => {
      win = await openWith(status({ listening: false, keyError: KEY_ERROR }));

      expect(el('remote-key-error').hidden).toBe(false);
      expect(text('remote-key-error-text')).toBe(KEY_ERROR);
      expect(text('remote-state')).toBe('Desactivado');

      click(el('remote-key-retry'));
      await win.settle('setRemoteEnabled', status());

      expect(win.argsFor('setRemoteEnabled')).toEqual([[true]]);
      expect(el('remote-key-error').hidden).toBe(true);
    });

    it('shows no key error while the key reads fine', async () => {
      win = await openWith(status());

      expect(el('remote-key-error').hidden).toBe(true);
    });

    it('notes, discreetly, a key kept without the keychain', async () => {
      win = await openWith(status({ keyUnsealed: true }));

      expect(el('remote-key-unsealed').hidden).toBe(false);
      expect(text('remote-key-unsealed')).toBe(
        'La clave del equipo se guarda sin el llavero del sistema.',
      );
    });

    it('says nothing about it when the keychain keeps it', async () => {
      win = await openWith(status());

      expect(el('remote-key-unsealed').hidden).toBe(true);
    });
  });
});
