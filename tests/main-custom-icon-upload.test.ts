import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ICON_EXTENSIONS,
  MAX_SVG_BYTES,
  MAX_UPLOAD_BYTES,
  pickCustomIcon,
  scaledSize,
  type CustomIconUploadDeps,
  type DecodedImage,
} from '../src/main/custom-icon-upload.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function image(
  width: number,
  height: number,
  log: string[] = [],
): DecodedImage {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: (opts) => {
      log.push(`resize ${opts.width}x${opts.height}`);
      return image(opts.width, opts.height, log);
    },
    toPNG: () => PNG_BYTES,
  };
}

function deps(
  overrides: Partial<CustomIconUploadDeps> = {},
): CustomIconUploadDeps {
  return {
    openDialog: () =>
      Promise.resolve({ canceled: false, filePaths: ['/pics/My Logo.png'] }),
    fileSize: () => 1024,
    readFile: () => Buffer.from('source bytes'),
    decodeImage: () => image(256, 128),
    ...overrides,
  };
}

describe('src/main/custom-icon-upload.ts', () => {
  describe('scaledSize', () => {
    it('fits the longest side into the box, keeping the aspect ratio', () => {
      expect(scaledSize(256, 128, 64)).toEqual({ width: 64, height: 32 });
      expect(scaledSize(100, 400, 64)).toEqual({ width: 16, height: 64 });
    });

    it('never upscales and never collapses a side to zero', () => {
      expect(scaledSize(20, 10, 64)).toEqual({ width: 20, height: 10 });
      expect(scaledSize(1000, 1, 64)).toEqual({ width: 64, height: 1 });
    });
  });

  it('offers only the formats nativeImage decodes on every platform', () => {
    expect(CUSTOM_ICON_EXTENSIONS).toEqual(['png', 'jpg', 'jpeg']);
  });

  it('offers PNG, JPG and SVG in the dialog', async () => {
    const offered: { name: string; extensions: string[] }[] = [];
    await pickCustomIcon(
      deps({
        openDialog: (options) => {
          offered.push(...options.filters);
          return Promise.resolve({ canceled: true, filePaths: [] });
        },
      }),
    );
    expect(offered).toEqual([
      { name: 'PNG, JPG o SVG', extensions: ['png', 'jpg', 'jpeg', 'svg'] },
    ]);
  });

  describe('an SVG file', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>';
    const svgDeps = (overrides: Partial<CustomIconUploadDeps> = {}) =>
      deps({
        openDialog: () =>
          Promise.resolve({ canceled: false, filePaths: ['/pics/Mark.SVG'] }),
        readFile: () => Buffer.from(SVG, 'utf8'),
        decodeImage: () => {
          throw new Error('nativeImage must not see an SVG');
        },
        ...overrides,
      });

    it('comes back as text for the renderer to rasterize', async () => {
      expect(await pickCustomIcon(svgDeps())).toEqual({
        ok: true,
        svg: { name: 'Mark', text: SVG },
      });
    });

    it('is refused over its own, smaller cap without being read', async () => {
      let read = false;
      const result = await pickCustomIcon(
        svgDeps({
          fileSize: () => MAX_SVG_BYTES + 1,
          readFile: () => {
            read = true;
            return Buffer.from(SVG);
          },
        }),
      );
      expect(MAX_SVG_BYTES).toBeLessThan(MAX_UPLOAD_BYTES);
      expect(result).toEqual({
        ok: false,
        error: 'La imagen SVG pesa más de 1 MB',
      });
      expect(read).toBe(false);
    });

    it('is refused when the file holds no <svg> element', async () => {
      expect(
        await pickCustomIcon(
          svgDeps({ readFile: () => Buffer.from('just text') }),
        ),
      ).toEqual({ ok: false, error: 'El archivo no es una imagen SVG' });
    });
  });

  it('resizes, re-encodes as PNG and ids the icon by the file content', async () => {
    const log: string[] = [];
    const result = await pickCustomIcon(
      deps({ decodeImage: () => image(256, 128, log) }),
    );
    expect(log).toEqual(['resize 64x32']);
    if (!result.ok || !('icon' in result))
      throw new Error('expected an upload');
    expect(result.icon.id).toMatch(/^[0-9a-f]{12}$/);
    expect(result.icon.name).toBe('My Logo');
    expect(result.icon.dataUrl).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    );
  });

  it('gives the same file the same id, and a different file another', async () => {
    const a = await pickCustomIcon(deps());
    const b = await pickCustomIcon(deps());
    const c = await pickCustomIcon(
      deps({ readFile: () => Buffer.from('other') }),
    );
    const icons = [a, b, c].map((r) => (r.ok && 'icon' in r ? r.icon : null));
    const [ia, ib, ic] = icons;
    if (!ia || !ib || !ic) throw new Error('expected uploads');
    expect(ia.id).toBe(ib.id);
    expect(ia.id).not.toBe(ic.id);
  });

  it('keeps a small image at its own size', async () => {
    const log: string[] = [];
    await pickCustomIcon(deps({ decodeImage: () => image(32, 32, log) }));
    expect(log).toEqual([]);
  });

  it('reports a cancelled dialog', async () => {
    const result = await pickCustomIcon(
      deps({
        openDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      }),
    );
    expect(result).toEqual({ ok: false, canceled: true });
  });

  it('rejects a file over the size cap without reading it', async () => {
    let read = false;
    const result = await pickCustomIcon(
      deps({
        fileSize: () => MAX_UPLOAD_BYTES + 1,
        readFile: () => {
          read = true;
          return Buffer.from('');
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'La imagen pesa más de 5 MB',
    });
    expect(read).toBe(false);
  });

  it('rejects a file nativeImage cannot decode', async () => {
    const result = await pickCustomIcon(
      deps({ decodeImage: () => image(0, 0) }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'No se pudo leer la imagen (usa PNG, JPG o SVG)',
    });
  });

  it('turns a failing dialog or read into an error result', async () => {
    expect(
      await pickCustomIcon(
        deps({ openDialog: () => Promise.reject(new Error('boom')) }),
      ),
    ).toEqual({ ok: false, error: 'boom' });
    expect(
      await pickCustomIcon(
        deps({
          readFile: () => {
            throw new Error('EACCES');
          },
        }),
      ),
    ).toEqual({ ok: false, error: 'No se pudo leer el archivo: EACCES' });
  });
});
