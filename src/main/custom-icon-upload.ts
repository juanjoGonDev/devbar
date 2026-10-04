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
 * Only PNG and JPEG: `nativeImage` decodes nothing else (checked on Electron
 * 43 — GIF, BMP and WebP buffers come back empty), and offering a format the
 * decoder then refuses would be a trap.
 */

export const CUSTOM_ICON_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

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

export type CustomIconUpload =
  | { ok: true; icon: CustomIcon }
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

/** Short content hash of the uploaded file: same file, same id. */
function contentId(bytes: Buffer): string {
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
      filters: [{ name: 'Imágenes', extensions: [...CUSTOM_ICON_EXTENSIONS] }],
    });
    source = res.canceled ? undefined : res.filePaths[0];
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (!source) return { ok: false, canceled: true };

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
    return { ok: false, error: 'No se pudo leer la imagen (usa PNG o JPEG)' };
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
      name: path.basename(source, path.extname(source)),
      dataUrl: `data:image/png;base64,${scaled.toPNG().toString('base64')}`,
    },
  };
}
