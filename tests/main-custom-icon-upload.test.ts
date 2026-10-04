import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ICON_EXTENSIONS,
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

  it('resizes, re-encodes as PNG and ids the icon by the file content', async () => {
    const log: string[] = [];
    const result = await pickCustomIcon(
      deps({ decodeImage: () => image(256, 128, log) }),
    );
    expect(log).toEqual(['resize 64x32']);
    if (!result.ok) throw new Error('expected an upload');
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
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected uploads');
    expect(a.icon.id).toBe(b.icon.id);
    expect(a.icon.id).not.toBe(c.icon.id);
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
      error: 'No se pudo leer la imagen (usa PNG o JPEG)',
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
