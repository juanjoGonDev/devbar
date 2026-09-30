// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createIconPicker } from '../renderer/config/icon-picker.js';
import { customIconList, setCustomIcons } from '../renderer/icon.js';
import type { CustomIcon } from '../src/domain-types.js';
import type {
  CustomIconUploadResult,
  IconBatteryItem,
} from '../src/ipc-contract.js';

/** The picker's uploads tab, its Spanish search and its tooltips. */

const RECENTS_KEY = 'devbar.recentIcons';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const logo: CustomIcon = { id: 'abc123', name: 'Logo empresa', dataUrl: PNG };
const other: CustomIcon = { id: 'def456', name: 'Mascota', dataUrl: PNG };

const BATTERY: IconBatteryItem[] = [
  { name: 'house', tags: ['home'], es: ['casa', 'hogar'], esName: 'casa' },
  {
    name: 'lock',
    tags: ['password'],
    es: ['candado', 'contraseña'],
    esName: 'candado',
  },
  { name: 'dog', tags: ['pet'] },
];

interface Api {
  upload: CustomIconUploadResult | Error;
  deleted: string[];
  deleteOk: boolean;
}

function setup(api: Partial<Api> = {}) {
  const state: Api = {
    upload: { ok: false, canceled: true },
    deleted: [],
    deleteOk: true,
    ...api,
  };
  document.body.innerHTML =
    '<dialog id="dlg"></dialog><button id="anchor" class="icon-btn"></button>';
  // As in config.html: the tab bar lives inside the popover.
  const picker = document.createElement('div');
  picker.setAttribute('hidden', '');
  const search = document.createElement('input');
  const tabs = document.createElement('div');
  tabs.id = 'icon-tabs';
  const grid = document.createElement('div');
  picker.append(search, tabs, grid);
  document.body.appendChild(picker);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getIconBattery: () => Promise.resolve(BATTERY),
      uploadCustomIcon: () =>
        state.upload instanceof Error
          ? Promise.reject(state.upload)
          : Promise.resolve(state.upload),
      deleteCustomIcon: (id: string) => {
        state.deleted.push(id);
        return Promise.resolve(
          state.deleteOk ? { ok: true } : { ok: false, canceled: true },
        );
      },
    },
  });
  const instance = createIconPicker({
    picker,
    search,
    grid,
    dialog: document.getElementById('dlg') as HTMLDialogElement,
  });
  const anchor = document.getElementById('anchor') as HTMLButtonElement;
  const picked: string[] = [];
  return {
    state,
    picker,
    search,
    grid,
    instance,
    picked,
    open: () => instance.open(anchor, (value) => picked.push(value)),
    tab: (group: string) =>
      document.querySelector<HTMLElement>(`#icon-tabs [data-group="${group}"]`),
    cellNames: () =>
      [...grid.querySelectorAll<HTMLElement>('.icon-cell')].map(
        (c) => c.dataset.name,
      ),
    type: (value: string) => {
      search.value = value;
      search.dispatchEvent(new Event('input'));
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('icon picker — uploads and Spanish search', () => {
  beforeEach(() => {
    localStorage.clear();
    setCustomIcons([]);
  });

  it('lists uploads under "Mis iconos", each deletable', async () => {
    setCustomIcons([logo, other]);
    const h = setup();
    await flush();
    h.open();
    h.tab('custom')?.click();
    expect(h.cellNames()).toEqual(['img:abc123', 'img:def456']);
    const cell = h.grid.querySelector<HTMLElement>('.icon-cell');
    expect(cell?.title).toBe('Logo empresa');
    expect(cell?.querySelector('img')?.getAttribute('src')).toBe(PNG);
    expect(
      h.grid.querySelector('.icon-cell-delete')?.getAttribute('aria-label'),
    ).toBe('Eliminar «Logo empresa»');
  });

  it('explains what can be uploaded when there is nothing yet', async () => {
    const h = setup();
    await flush();
    h.open();
    h.tab('custom')?.click();
    expect(h.grid.querySelector('.icon-custom-empty')?.textContent).toMatch(
      /PNG o JPEG/,
    );
    expect(h.grid.querySelector('.icon-upload-btn')?.textContent).toContain(
      'Subir imagen…',
    );
  });

  it('uploads, adds the image to the library and picks it', async () => {
    const h = setup({ upload: { ok: true, icon: logo } });
    await flush();
    h.open();
    h.tab('custom')?.click();
    h.grid.querySelector<HTMLButtonElement>('.icon-upload-btn')?.click();
    await flush();
    expect(h.picked).toEqual(['img:abc123']);
    expect(customIconList()).toEqual([logo]);
    expect(h.picker.hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')).toEqual([
      'img:abc123',
    ]);
  });

  it('shows why an upload failed, and stays quiet on a cancel', async () => {
    const h = setup({
      upload: { ok: false, error: 'La imagen pesa más de 5 MB' },
    });
    await flush();
    h.open();
    h.tab('custom')?.click();
    const status = () =>
      h.grid.querySelector('.icon-custom-status')?.textContent;
    h.grid.querySelector<HTMLButtonElement>('.icon-upload-btn')?.click();
    await flush();
    expect(status()).toBe('La imagen pesa más de 5 MB');
    h.state.upload = { ok: false, canceled: true };
    h.grid.querySelector<HTMLButtonElement>('.icon-upload-btn')?.click();
    await flush();
    expect(status()).toBe('');
    h.state.upload = new Error('ipc down');
    h.grid.querySelector<HTMLButtonElement>('.icon-upload-btn')?.click();
    await flush();
    expect(status()).toBe('No se pudo subir la imagen');
    expect(h.picked).toEqual([]);
  });

  it('deletes through main and drops the cell once confirmed', async () => {
    setCustomIcons([logo, other]);
    const h = setup();
    await flush();
    h.open();
    h.tab('custom')?.click();
    h.grid.querySelector<HTMLButtonElement>('.icon-cell-delete')?.click();
    await flush();
    expect(h.state.deleted).toEqual(['abc123']);
    expect(h.cellNames()).toEqual(['img:def456']);
    // Deleting is not picking.
    expect(h.picked).toEqual([]);
    expect(h.picker.hidden).toBe(false);
  });

  it('keeps the cell when the deletion is cancelled', async () => {
    setCustomIcons([logo]);
    const h = setup({ deleteOk: false });
    await flush();
    h.open();
    h.tab('custom')?.click();
    h.grid.querySelector<HTMLButtonElement>('.icon-cell-delete')?.click();
    await flush();
    expect(h.cellNames()).toEqual(['img:abc123']);
  });

  it('remembers uploads in recents while they exist', async () => {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(['img:abc123', 'img:gone99', 'dog']),
    );
    setCustomIcons([logo]);
    const h = setup();
    await flush();
    h.open();
    expect(h.cellNames()).toEqual(['img:abc123', 'dog']);
  });

  it('refreshes an open picker when the library changes, and ignores a closed one', async () => {
    const h = setup();
    await flush();
    h.instance.refresh();
    h.open();
    h.tab('custom')?.click();
    setCustomIcons([logo]);
    h.instance.refresh();
    expect(h.cellNames()).toEqual(['img:abc123']);
  });

  it('searches in Spanish and English, uploads first, accents ignored', async () => {
    setCustomIcons([{ ...logo, name: 'Casa de campo' }]);
    const h = setup();
    await flush();
    h.open();
    h.type('casa');
    expect(h.cellNames()).toEqual(['img:abc123', 'house']);
    h.type('contrasena');
    expect(h.cellNames()).toEqual(['lock']);
    h.type('home');
    expect(h.cellNames()).toEqual(['house']);
  });

  it('shows the Spanish name in the tooltip when there is one', async () => {
    const h = setup();
    await flush();
    h.open();
    const [house, , dog] = [
      ...h.grid.querySelectorAll<HTMLElement>('.icon-cell'),
    ];
    expect(house?.title).toBe('house · casa');
    expect(dog?.title).toBe('dog');
  });
});
