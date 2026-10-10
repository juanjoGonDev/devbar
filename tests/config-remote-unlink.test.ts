// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  RemoteDeviceRow,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * «¿Desvincular este dispositivo?», the dialog «Desvincular» in a device's
 * «⋯» menu opens instead of unlinking at once (renderer/config/remote-
 * unlink-dialog.ts), driven through the real config window: what it says
 * about the device, that only its own button unlinks, that it leaves when
 * the device does, and where focus goes back to.
 */

const HOUR = 60 * 60_000;
const NOTE =
  'Perderá el acceso al momento. Para volver a usarlo tendrás que vincularlo otra vez.';

function status(extra: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    autoUnlink: true,
    notifyConnections: true,
    port: 47821,
    listening: true,
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
    lastSeenAt: Date.now() - 3 * HOUR,
    verifiedAt: null,
    lastIp: '192.168.1.57',
    connected: false,
    ...extra,
  };
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found as T;
}
const squash = (node: Node | null | undefined): string =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const click = (target: Element | null | undefined): void => {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const dialog = (): HTMLDialogElement =>
  el<HTMLDialogElement>('remote-unlink-dialog');
/** The «⋯» button of the device's row, as the list holds it now. */
const trigger = (id = 'd1'): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(
    `#remote-devices button[data-device-id="${id}"]`,
  );
  if (!found) throw new Error(`no «⋯» for ${id}`);
  return found;
};
/** «Desvincular» in the device's «⋯» menu. */
const chooseUnlink = (id = 'd1'): void => {
  click(trigger(id));
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#remote-devices [role="menuitem"]',
    ),
  ].find(
    // The words, without the icon's glyph.
    (each) => squash(each.querySelector('span:not(.icon)')) === 'Desvincular',
  );
  click(item);
};
/** The summary card's muted lines, in order. */
const lines = (): string[] =>
  [...el('remote-unlink-device').querySelectorAll('.remote-unlink-line')].map(
    (line) => squash(line),
  );

async function openWith(devices: RemoteDeviceRow[]): Promise<RendererWindow> {
  const win = await openConfigWindow();
  await win.settle('getRemoteStatus', status({ devices }));
  return win;
}

describe('renderer/config/remote-unlink-dialog.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('opening', () => {
    it('asks first: «Desvincular» opens the dialog and unlinks nothing', async () => {
      win = await openWith([device()]);

      chooseUnlink();

      expect(dialog().open).toBe(true);
      expect(squash(dialog().querySelector('h2'))).toBe(
        '¿Desvincular este dispositivo?',
      );
      expect(squash(el('remote-unlink-note'))).toBe(NOTE);
      expect(win.argsFor('unlinkRemoteDevice')).toEqual([]);
    });

    it('puts focus on «Cancelar»', async () => {
      win = await openWith([device()]);

      chooseUnlink();

      expect(document.activeElement).toBe(el('remote-unlink-cancel'));
      expect(squash(el('remote-unlink-cancel'))).toBe('Cancelar');
      expect(squash(el('remote-unlink-confirm'))).toBe('Desvincular');
      expect(el('remote-unlink-confirm').classList.contains('danger')).toBe(
        true,
      );
    });
  });

  describe('the device it is about', () => {
    it('tells an unverified, idle device apart', async () => {
      win = await openWith([device(), device({ id: 'd2', name: 'iPad' })]);

      chooseUnlink();

      const card = el('remote-unlink-device');
      expect(card.querySelector('[data-icon="smartphone"]')).not.toBeNull();
      expect(squash(card.querySelector('.remote-device-name'))).toBe(
        'iPhone de Ana',
      );
      expect(card.querySelector('[role="img"]')).toBeNull();
      expect(card.querySelector('.remote-presence')).toBeNull();
      expect(lines()).toHaveLength(4);
      expect(lines()[0]).toBe('Safari · iOS');
      expect(lines()[1]).toBe('192.168.1.57');
      expect(lines()[2]).toMatch(/^Vinculado el 1 oct\.? 2026$/);
      expect(lines()[3]).toBe('Última conexión hace 3 h');
    });

    it('tells a verified, connected device apart, without an IP it never had', async () => {
      win = await openWith([
        device({ verifiedAt: Date.now(), connected: true, lastIp: null }),
      ]);

      chooseUnlink();

      const card = el('remote-unlink-device');
      const mark = card.querySelector('[role="img"]');
      expect(mark?.getAttribute('aria-label')).toBe('Verificado');
      expect(card.querySelector('.remote-presence')).not.toBeNull();
      expect(lines()).toHaveLength(3);
      expect(lines()[0]).toBe('Safari · iOS');
      expect(lines()[2]).toBe('Conectado');
    });
  });

  describe('cancelling', () => {
    it('does nothing on «Cancelar», and gives focus back to the «⋯»', async () => {
      win = await openWith([device()]);
      chooseUnlink();

      click(el('remote-unlink-cancel'));

      expect(dialog().open).toBe(false);
      expect(win.argsFor('unlinkRemoteDevice')).toEqual([]);
      expect(document.activeElement).toBe(trigger());
    });

    it('does nothing on Escape', async () => {
      win = await openWith([device()]);
      chooseUnlink();

      const escape = new Event('cancel', { cancelable: true });
      dialog().dispatchEvent(escape);

      expect(dialog().open).toBe(false);
      expect(win.argsFor('unlinkRemoteDevice')).toEqual([]);
      expect(document.activeElement).toBe(trigger());
    });

    it('does nothing on a click outside it', async () => {
      win = await openWith([device()]);
      chooseUnlink();

      click(dialog());

      expect(dialog().open).toBe(false);
      expect(win.argsFor('unlinkRemoteDevice')).toEqual([]);
      expect(document.activeElement).toBe(trigger());
    });

    it("finds the row's new «⋯» when the list repainted meanwhile", async () => {
      win = await openWith([device(), device({ id: 'd2', name: 'iPad' })]);
      chooseUnlink('d2');
      const before = trigger('d2');
      await win.push(
        'onRemoteChanged',
        status({
          devices: [
            device(),
            device({ id: 'd2', name: 'iPad', connected: true }),
          ],
        }),
      );

      click(el('remote-unlink-cancel'));

      expect(trigger('d2')).not.toBe(before);
      expect(document.activeElement).toBe(trigger('d2'));
    });
  });

  describe('confirming', () => {
    it('unlinks the device on «Desvincular», and says so', async () => {
      win = await openWith([device()]);
      chooseUnlink();

      click(el('remote-unlink-confirm'));

      expect(dialog().open).toBe(false);
      expect(trigger().disabled).toBe(true);
      await win.settle('unlinkRemoteDevice', { ok: true });
      expect(win.argsFor('unlinkRemoteDevice')).toEqual([['d1']]);
      expect(squash(el('toast'))).toContain('iPhone de Ana');
      expect(trigger().disabled).toBe(false);
    });

    it('reports an unlink main refused', async () => {
      win = await openWith([device()]);
      chooseUnlink();

      click(el('remote-unlink-confirm'));
      await win.settle('unlinkRemoteDevice', {
        ok: false,
        error: 'Ese dispositivo ya no está vinculado.',
      });

      expect(squash(el('toast'))).toBe('Ese dispositivo ya no está vinculado.');
    });
  });

  describe('a device that goes away meanwhile', () => {
    it('closes when the device is unlinked elsewhere', async () => {
      win = await openWith([device(), device({ id: 'd2', name: 'iPad' })]);
      chooseUnlink();

      await win.push(
        'onRemoteChanged',
        status({ devices: [device({ id: 'd2', name: 'iPad' })] }),
      );

      expect(dialog().open).toBe(false);
      expect(win.argsFor('unlinkRemoteDevice')).toEqual([]);
    });

    it('stays open while its device is still there', async () => {
      win = await openWith([device()]);
      chooseUnlink();

      await win.push(
        'onRemoteChanged',
        status({ devices: [device({ connected: true })] }),
      );

      expect(dialog().open).toBe(true);
      expect(lines().at(-1)).toBe('Conectado');
    });
  });
});
