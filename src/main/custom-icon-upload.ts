import { createHash } from 'node:crypto';
import path from 'node:path';
import { CUSTOM_ICON_MAX_SIDE } from '../custom-icons.js';
import type { CustomIcon } from '../domain-types.js';
import { errorMessage } from './ipc-validators.js';

/**
 * Turns an image file the user picks into a CustomIcon: decoded by Electron's
 * `nativeImage`, scaled down so its longest side is 64 px, re-encoded as PNG
 * and inlined as a data URL. Re-encoding is what makes the stored bytes safe
 * to paint whatever the file really held.
 *
 * `nativeImage` decodes PNG and JPEG only (checked on Electron 43 — GIF, BMP
 * and WebP buffers come back empty, and SVG is not a bitmap at all), and
 * offering a format the decoder then refuses would be a trap.
 *
 * SVG takes another road: main only reads the text and hands it back to the
 * config renderer that asked, which rasterizes it through an `<img>` (no
 * scripts, no external loads) and sends the PNG back on
 * `customIcons:addRasterized`. The SVG itself is never decoded here, never
 * written anywhere and never stored.
 */

/** What `nativeImage` decodes. */
export const CUSTOM_ICON_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;
const SVG_EXTENSION = 'svg';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** An icon-sized SVG is a few KB; 1 MB of markup is not an icon. */
export const MAX_SVG_BYTES = 1024 * 1024;
const SVG_ELEMENT = /<svg[\s>/]/i;

/** The slice of `NativeImage` this module uses. */
export interface DecodedImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality: 'best';
  }): DecodedImage;
  toPNG(): Buffer;
}

export interface CustomIconUploadDeps {
  openDialog(options: {
    title: string;
    properties: 'openFile'[];
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  fileSize(filePath: string): number;
  readFile(filePath: string): Buffer;
  decodeImage(bytes: Buffer): DecodedImage;
}

/** An SVG the renderer still has to rasterize before anything is stored. */
interface SvgIconSource {
  name: string;
  text: string;
}

export type CustomIconUpload =
  | { ok: true; icon: CustomIcon }
  | { ok: true; svg: SvgIconSource }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

/** Fits `width × height` into a `max` square, never upscaling. */
export function scaledSize(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const factor = max / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Short content hash: same bytes, same id. A PNG/JPEG upload hashes the
 * file; a rasterized SVG hashes the PNG the renderer produced, since that is
 * all main ever sees of it.
 */
export function contentId(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

export async function pickCustomIcon(
  deps: CustomIconUploadDeps,
): Promise<CustomIconUpload> {
  let source: string | undefined;
  try {
    const res = await deps.openDialog({
      title: 'Subir imagen como icono',
      properties: ['openFile'],
      filters: [
        {
          name: 'PNG, JPG o SVG',
          extensions: [...CUSTOM_ICON_EXTENSIONS, SVG_EXTENSION],
        },
      ],
    });
    source = res.canceled ? undefined : res.filePaths[0];
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (!source) return { ok: false, canceled: true };
  const name = path.basename(source, path.extname(source));
  if (path.extname(source).toLowerCase() === `.${SVG_EXTENSION}`)
    return readSvg(deps, source, name);

  let bytes: Buffer;
  try {
    // Checked before reading: a huge file must not be slurped just to be
    // refused.
    if (deps.fileSize(source) > MAX_UPLOAD_BYTES)
      return { ok: false, error: 'La imagen pesa más de 5 MB' };
    bytes = deps.readFile(source);
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo leer el archivo: ${errorMessage(err)}`,
    };
  }

  const decoded = deps.decodeImage(bytes);
  if (decoded.isEmpty())
    return {
      ok: false,
      error: 'No se pudo leer la imagen (usa PNG, JPG o SVG)',
    };
  const { width, height } = decoded.getSize();
  const target = scaledSize(width, height, CUSTOM_ICON_MAX_SIDE);
  const scaled =
    target.width === width && target.height === height
      ? decoded
      : decoded.resize({ ...target, quality: 'best' });

  return {
    ok: true,
    icon: {
      id: contentId(bytes),
      name,
      dataUrl: `data:image/png;base64,${scaled.toPNG().toString('base64')}`,
    },
  };
}

function readSvg(
  deps: CustomIconUploadDeps,
  source: string,
  name: string,
): CustomIconUpload {
  let text: string;
  try {
    if (deps.fileSize(source) > MAX_SVG_BYTES)
      return { ok: false, error: 'La imagen SVG pesa más de 1 MB' };
    text = deps.readFile(source).toString('utf8');
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo leer el archivo: ${errorMessage(err)}`,
    };
  }
  if (!SVG_ELEMENT.test(text))
    return { ok: false, error: 'El archivo no es una imagen SVG' };
  return { ok: true, svg: { name, text } };
}
