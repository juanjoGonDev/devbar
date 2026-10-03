import { describe, expect, it } from 'vitest';
import {
  registerIconsIpc,
  type IconsIpcDeps,
} from '../src/main/ipc/icons-ipc.js';
import type { CustomIcon } from '../src/domain-types.js';
import { recordingIpc } from './helpers/main-fakes.js';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const logo: CustomIcon = { id: 'abc123def456', name: 'logo', dataUrl: PNG };

function harness(overrides: Partial<IconsIpcDeps> = {}) {
  let library: CustomIcon[] = [];
  const changed: CustomIcon[][] = [];
  const asked: string[] = [];
  let response = 1;
  const ipc = recordingIpc();
  registerIconsIpc(ipc, {
    configStore: {
      listCustomIcons: () => library,
      addCustomIcon: (icon) => {
        const existing = library.find((i) => i.id === icon.id);
        if (existing) return { icon: existing, added: false };
        library = [...library, icon];
        return { icon, added: true };
      },
      deleteCustomIcon: (id) => {
        library = library.filter((i) => i.id !== id);
      },
    },
    pickCustomIcon: () => Promise.resolve({ ok: true, icon: logo }),
    confirm: (options) => {
      asked.push(options.message);
      return Promise.resolve({ response });
    },
    customIconsChanged: (icons) => changed.push(icons),
    ...overrides,
  });
  return {
    ipc,
    changed,
    asked,
    library: () => library,
    setLibrary: (icons: CustomIcon[]) => (library = icons),
    respond: (value: number) => (response = value),
  };
}

describe('src/main/ipc/icons-ipc.ts', () => {
  it('lists the library', () => {
    const h = harness();
    h.setLibrary([logo]);
    expect(h.ipc.invoke('customIcons:list')).toEqual([logo]);
  });

  it('stores an upload and tells every window', async () => {
    const h = harness();
    expect(await h.ipc.invoke('customIcons:upload')).toEqual({
      ok: true,
      icon: logo,
    });
    expect(h.library()).toEqual([logo]);
    expect(h.changed).toEqual([[logo]]);
  });

  it('answers the stored icon for a re-upload, without a change push', async () => {
    const h = harness();
    h.setLibrary([{ ...logo, name: 'first' }]);
    expect(await h.ipc.invoke('customIcons:upload')).toEqual({
      ok: true,
      icon: { ...logo, name: 'first' },
    });
    expect(h.changed).toEqual([]);
  });

  it('passes a cancel or an error through untouched', async () => {
    const cancel = harness({
      pickCustomIcon: () => Promise.resolve({ ok: false, canceled: true }),
    });
    expect(await cancel.ipc.invoke('customIcons:upload')).toEqual({
      ok: false,
      canceled: true,
    });
    const error = harness({
      pickCustomIcon: () => Promise.resolve({ ok: false, error: 'bad' }),
    });
    expect(await error.ipc.invoke('customIcons:upload')).toEqual({
      ok: false,
      error: 'bad',
    });
  });

  it('refuses an encoded image the store would not keep', async () => {
    const h = harness({
      pickCustomIcon: () =>
        Promise.resolve({
          ok: true,
          icon: { ...logo, dataUrl: `${PNG}${'A'.repeat(200_000)}` },
        }),
    });
    expect(await h.ipc.invoke('customIcons:upload')).toEqual({
      ok: false,
      error: 'La imagen resultante no es válida',
    });
    expect(h.library()).toEqual([]);
  });

  it('reports a full library as an error', async () => {
    const h = harness({
      configStore: {
        listCustomIcons: () => [],
        addCustomIcon: () => {
          throw new Error('lleno');
        },
        deleteCustomIcon: () => undefined,
      },
    });
    expect(await h.ipc.invoke('customIcons:upload')).toEqual({
      ok: false,
      error: 'lleno',
    });
  });

  describe('an SVG upload', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const svgUpload = () =>
      harness({
        pickCustomIcon: () =>
          Promise.resolve({ ok: true, svg: { name: 'mark', text: SVG } }),
      });
    const isPng = (icon: CustomIcon) =>
      icon.dataUrl.startsWith('data:image/png;base64,');

    it('hands the text back to rasterize and stores nothing yet', async () => {
      const h = svgUpload();
      expect(await h.ipc.invoke('customIcons:upload')).toEqual({
        ok: true,
        svg: { name: 'mark', text: SVG },
      });
      expect(h.library()).toEqual([]);
      expect(h.changed).toEqual([]);
    });

    it('stores the rasterized PNG, id-ed by its pixels, and tells every window', async () => {
      const h = svgUpload();
      await h.ipc.invoke('customIcons:upload');
      const res = await h.ipc.invoke('customIcons:addRasterized', {
        name: '  mark  ',
        dataUrl: PNG,
      });
      const [stored] = h.library();
      expect(stored?.id).toMatch(/^[0-9a-f]{12}$/);
      expect(res).toEqual({
        ok: true,
        icon: { id: stored?.id, name: 'mark', dataUrl: PNG },
      });
      expect(h.changed).toHaveLength(1);
      // The same pixels dedupe onto the same icon.
      const again = await h.ipc.invoke('customIcons:addRasterized', {
        name: 'otra',
        dataUrl: PNG,
      });
      expect(again).toEqual(res);
      expect(h.library()).toHaveLength(1);
      expect(h.library().every(isPng)).toBe(true);
    });

    it('never stores anything but a PNG, whatever the renderer sends', async () => {
      const h = svgUpload();
      for (const dataUrl of [
        `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`,
        'data:image/png;base64,AAAA',
        `${PNG}${'A'.repeat(200_000)}`,
      ]) {
        expect(
          await h.ipc.invoke('customIcons:addRasterized', {
            name: 'mark',
            dataUrl,
          }),
        ).toEqual({ ok: false, error: 'La imagen resultante no es válida' });
      }
      expect(h.library()).toEqual([]);
      expect(h.changed).toEqual([]);
    });

    it('reports a full library as an error', async () => {
      const h = harness({
        configStore: {
          listCustomIcons: () => [],
          addCustomIcon: () => {
            throw new Error('lleno');
          },
          deleteCustomIcon: () => undefined,
        },
      });
      expect(
        await h.ipc.invoke('customIcons:addRasterized', {
          name: 'mark',
          dataUrl: PNG,
        }),
      ).toEqual({ ok: false, error: 'lleno' });
    });

    it('rejects a malformed payload', () => {
      const h = harness();
      expect(() =>
        h.ipc.invoke('customIcons:addRasterized', { name: 'x' }),
      ).toThrow('Invalid IPC dataUrl');
    });
  });

  it('deletes only after the user confirms', async () => {
    const h = harness();
    h.setLibrary([logo]);
    expect(await h.ipc.invoke('customIcons:delete', { id: logo.id })).toEqual({
      ok: true,
    });
    expect(h.asked).toEqual(['¿Eliminar el icono «logo»?']);
    expect(h.library()).toEqual([]);
    expect(h.changed).toEqual([[]]);
  });

  it('keeps the icon when the user cancels', async () => {
    const h = harness();
    h.setLibrary([logo]);
    h.respond(0);
    expect(await h.ipc.invoke('customIcons:delete', { id: logo.id })).toEqual({
      ok: false,
      canceled: true,
    });
    expect(h.library()).toEqual([logo]);
    expect(h.changed).toEqual([]);
  });

  it('treats an unknown id as already gone', async () => {
    const h = harness();
    expect(await h.ipc.invoke('customIcons:delete', { id: 'nope12' })).toEqual({
      ok: true,
    });
    expect(h.asked).toEqual([]);
  });

  it('rejects a malformed delete payload', async () => {
    const h = harness();
    await expect(h.ipc.invoke('customIcons:delete', {})).rejects.toThrow();
  });
});
