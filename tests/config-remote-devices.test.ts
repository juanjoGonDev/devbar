// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { flush, openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  RemoteDeviceRow,
  RemoteStatus,
} from '../src/ipc-contract/remote-api.js';

/**
 * The «Dispositivos» list of «Control remoto», driven through the real config
 * window with a hand-driven `window.api`: what each row says, the empty
 * state, and the «⋯» menu that holds a device's actions (security code,
 * rename, unlink). The security-code dialog itself is
 * tests/config-remote-security.test.ts.
 */

const HOUR = 60 * 60_000;

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
    lastSeenAt: Date.now(),
    verifiedAt: null,
    lastIp: null,
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
/** A menu item's words, without its icon glyph. */
const label = (item: Element | undefined): string =>
  squash(item?.querySelector('span:not(.icon)'));
const click = (target: Element | null | undefined): void => {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const press = (target: Element | null | undefined, key: string): void => {
  target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('#remote-devices > li'),
];
const trigger = (index = 0): HTMLButtonElement => {
  const found = rows()[index]?.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
  );
  if (!found) throw new Error(`no «⋯» in row ${index}`);
  return found;
};
const menus = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('#remote-devices [role="menu"]'),
];
const items = (menu: HTMLElement | undefined): HTMLButtonElement[] => [
  ...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
];
const openMenu = (index = 0): HTMLElement => {
  click(trigger(index));
  const menu = rows()[index]?.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error(`no menu in row ${index}`);
  return menu;
};
const choose = (text: string, index = 0): void => {
  click(items(openMenu(index)).find((item) => label(item) === text));
};

async function openWith(initial: RemoteStatus): Promise<RendererWindow> {
  const win = await openConfigWindow();
  await win.settle('getRemoteStatus', initial);
  return win;
}

describe('renderer/config/remote-devices.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  describe('the empty state', () => {
    it('shows a QR glyph and how to add the first device', async () => {
      win = await openWith(status());
      const empty = el('remote-devices-empty');

      expect(squash(el('remote-device-count'))).toBe('0');
      expect(empty.hidden).toBe(false);
      expect(empty.querySelector('[data-icon="qr-code"]')).not.toBeNull();
      expect(squash(empty.querySelector('.remote-empty-title'))).toBe(
        'Ningún dispositivo vinculado',
      );
      expect(squash(empty.querySelector('.remote-empty-hint'))).toBe(
        'Pulsa Añadir y escanea el código con la cámara del móvil.',
      );
      expect(rows()).toEqual([]);
    });

    it('hides once a device is linked, and counts it', async () => {
      win = await openWith(status({ devices: [device()] }));

      expect(el('remote-devices-empty').hidden).toBe(true);
      expect(squash(el('remote-device-count'))).toBe('1');
    });
  });

  describe('each row', () => {
    it('shows the name, then the client and the last IP on one line', async () => {
      win = await openWith(
        status({ devices: [device({ lastIp: '192.168.1.57' })] }),
      );
      const [row] = rows();

      expect(squash(row?.querySelector('.remote-device-name'))).toBe(
        'iPhone de Ana',
      );
      expect(squash(row?.querySelector('.remote-device-meta'))).toBe(
        'Safari · iOS · 192.168.1.57',
      );
    });

    it('shows only the client while the device has no IP yet', async () => {
      win = await openWith(status({ devices: [device()] }));

      expect(squash(rows()[0]?.querySelector('.remote-device-meta'))).toBe(
        'Safari · iOS',
      );
    });

    it('keeps the link date on hover', async () => {
      win = await openWith(status({ devices: [device()] }));

      expect(
        rows()[0]?.querySelector<HTMLElement>('.remote-device-meta')?.title,
      ).toMatch(/^Safari · iOS\nVinculado el 1 oct\.? 2026$/);
    });

    it('marks a verified device with a shield, and an unverified one with nothing', async () => {
      win = await openWith(
        status({
          devices: [
            device({ verifiedAt: Date.now() }),
            device({ id: 'd2', name: 'iPad' }),
          ],
        }),
      );
      const [verified, unverified] = rows();
      const mark = verified?.querySelector<HTMLElement>('[role="img"]');

      expect(mark?.getAttribute('aria-label')).toBe('Verificado');
      expect(mark?.title).toBe('Verificado');
      expect(mark?.querySelector('[data-icon="shield-check"]')).not.toBeNull();
      expect(unverified?.querySelector('[role="img"]')).toBeNull();
      expect(squash(el('remote-devices'))).not.toMatch(/Sin verificar/);
    });

    it('says «Conectado» with a presence dot while the device holds a stream open', async () => {
      win = await openWith(status({ devices: [device({ connected: true })] }));
      const seen = rows()[0]?.querySelector('.remote-seen');

      expect(squash(seen)).toBe('Conectado');
      expect(seen?.classList.contains('is-online')).toBe(true);
      expect(rows()[0]?.querySelector('.remote-presence')).not.toBeNull();
    });

    it('says how long ago an idle device was last seen', async () => {
      win = await openWith(
        status({ devices: [device({ lastSeenAt: Date.now() - 3 * HOUR })] }),
      );
      const seen = rows()[0]?.querySelector('.remote-seen');

      expect(squash(seen)).toBe('Última conexión hace 3 h');
      expect(squash(seen?.querySelector('.sr-only'))).toBe('Última conexión');
      expect(seen?.classList.contains('is-online')).toBe(false);
      expect(rows()[0]?.querySelector('.remote-presence')).toBeNull();
    });
  });

  describe('the «⋯» menu', () => {
    it('is a closed menu button named after its device', async () => {
      win = await openWith(status({ devices: [device()] }));

      expect(trigger().getAttribute('aria-label')).toBe(
        'Acciones de iPhone de Ana',
      );
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
      expect(menus()).toEqual([]);
    });

    it('opens with focus on its first item', async () => {
      win = await openWith(status({ devices: [device()] }));

      const menu = openMenu();

      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(items(menu)[0]);
    });

    it('offers to verify an unverified device, then rename and unlink', async () => {
      win = await openWith(status({ devices: [device()] }));

      const menu = openMenu();

      expect(items(menu).map(label)).toEqual([
        'Verificar con código',
        'Renombrar',
        'Desvincular',
      ]);
      expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
      expect(items(menu)[2]?.classList.contains('is-danger')).toBe(true);
    });

    it('offers the security code of a verified device', async () => {
      win = await openWith(
        status({ devices: [device({ verifiedAt: Date.now() })] }),
      );

      expect(label(items(openMenu())[0])).toBe('Código de seguridad');
    });

    it('closes when its button is clicked again', async () => {
      win = await openWith(status({ devices: [device()] }));
      openMenu();

      click(trigger());

      expect(menus()).toEqual([]);
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps only one menu open at a time', async () => {
      win = await openWith(
        status({ devices: [device(), device({ id: 'd2', name: 'iPad' })] }),
      );
      openMenu(0);

      openMenu(1);

      expect(menus()).toHaveLength(1);
      expect(rows()[1]?.contains(menus()[0] ?? null)).toBe(true);
      expect(trigger(0).getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on Escape and gives focus back to its button', async () => {
      win = await openWith(status({ devices: [device()] }));
      const menu = openMenu();

      press(items(menu)[0], 'Escape');

      expect(menus()).toEqual([]);
      expect(document.activeElement).toBe(trigger());
    });

    it('closes on a click anywhere else', async () => {
      win = await openWith(status({ devices: [device()] }));
      openMenu();

      click(el('remote-add-device').closest('section'));

      expect(menus()).toEqual([]);
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
    });

    it('moves between its items with the arrow keys, wrapping around', async () => {
      win = await openWith(status({ devices: [device()] }));
      const menu = openMenu();
      const [first, second, last] = items(menu);

      press(first, 'ArrowDown');
      expect(document.activeElement).toBe(second);
      press(second, 'End');
      expect(document.activeElement).toBe(last);
      press(last, 'ArrowDown');
      expect(document.activeElement).toBe(first);
      press(first, 'ArrowUp');
      expect(document.activeElement).toBe(last);
      press(last, 'Home');
      expect(document.activeElement).toBe(first);
    });

    it('closes when the list repaints, keeping focus on that device', async () => {
      win = await openWith(status({ devices: [device()] }));
      openMenu();

      await win.push(
        'onRemoteChanged',
        status({ devices: [device({ connected: true })] }),
      );

      expect(menus()).toEqual([]);
      expect(document.activeElement).toBe(trigger());
    });

    it('unlinks with «Desvincular»', async () => {
      win = await openWith(status({ devices: [device()] }));

      choose('Desvincular');
      expect(menus()).toEqual([]);
      expect(trigger().disabled).toBe(true);
      await win.settle('unlinkRemoteDevice', { ok: true });

      expect(win.argsFor('unlinkRemoteDevice')).toEqual([['d1']]);
      expect(squash(el('toast'))).toContain('iPhone de Ana');
      expect(trigger().disabled).toBe(false);
    });

    it('reports an unlink main refused', async () => {
      win = await openWith(status({ devices: [device()] }));

      choose('Desvincular');
      await win.settle('unlinkRemoteDevice', {
        ok: false,
        error: 'Ese dispositivo ya no está vinculado.',
      });

      expect(squash(el('toast'))).toBe('Ese dispositivo ya no está vinculado.');
    });
  });

  describe('«Renombrar»', () => {
    const startRename = (): HTMLInputElement => {
      choose('Renombrar');
      const input = rows()[0]?.querySelector('input');
      if (!input) throw new Error('no rename input');
      return input;
    };
    const nameShown = (): string =>
      squash(rows()[0]?.querySelector('.remote-device-name'));

    it('turns the name into a focused field holding it', async () => {
      win = await openWith(status({ devices: [device()] }));

      const input = startRename();

      expect(menus()).toEqual([]);
      expect(input.value).toBe('iPhone de Ana');
      expect(input.getAttribute('aria-label')).toBe('Nombre del dispositivo');
      expect(document.activeElement).toBe(input);
    });

    it('saves the new name on Enter', async () => {
      win = await openWith(status({ devices: [device()] }));
      const input = startRename();

      input.value = '  Tablet  ';
      press(input, 'Enter');
      await win.push(
        'onRemoteChanged',
        status({ devices: [device({ name: 'Tablet' })] }),
      );
      // Still editing until main answers: the push must not wipe the input.
      expect(rows()[0]?.querySelector('input')).not.toBeNull();
      await win.settle('renameRemoteDevice', { ok: true });

      expect(win.argsFor('renameRemoteDevice')).toEqual([['d1', 'Tablet']]);
      expect(nameShown()).toBe('Tablet');
    });

    it('cancels on Escape without asking main', async () => {
      win = await openWith(status({ devices: [device()] }));
      const input = startRename();

      input.value = 'Otro';
      press(input, 'Escape');
      await flush();

      expect(win.callCount('renameRemoteDevice')).toBe(0);
      expect(nameShown()).toBe('iPhone de Ana');
    });

    it('saves once when the field loses focus after Enter', async () => {
      win = await openWith(status({ devices: [device()] }));
      const input = startRename();

      input.value = 'Tablet';
      press(input, 'Enter');
      input.dispatchEvent(new Event('blur'));
      await win.settle('renameRemoteDevice', {
        ok: false,
        error: 'El nombre debe tener entre 1 y 40 caracteres.',
      });

      expect(win.callCount('renameRemoteDevice')).toBe(1);
      expect(squash(el('toast'))).toBe(
        'El nombre debe tener entre 1 y 40 caracteres.',
      );
    });

    it('does not ask main when the name did not change', async () => {
      win = await openWith(status({ devices: [device()] }));
      const input = startRename();

      input.dispatchEvent(new Event('blur'));
      await flush();

      expect(win.callCount('renameRemoteDevice')).toBe(0);
      expect(rows()[0]?.querySelector('input')).toBeNull();
    });
  });
});
