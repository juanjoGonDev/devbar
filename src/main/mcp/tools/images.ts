import { CUSTOM_ICON_MAX_SIDE, customIconRef } from '../../../custom-icons.js';
import {
  contentId,
  MAX_SVG_BYTES,
  MAX_UPLOAD_BYTES,
  scaledSize,
} from '../../custom-icon-upload.js';
import type { McpConfigPort } from '../config-changes.js';
import type { ImageInput } from './config-schemas.js';
import { ToolError } from './tool-kit.js';

/**
 * An image an assistant sends as an icon, through the same pipeline as an
 * upload in Settings: a PNG or JPEG is decoded and re-encoded to a PNG of at
 * most 64 px, an SVG is drawn to one (it is never stored as SVG), and the
 * result joins the icon library through the very handler the config window
 * uses — but only once the change it belongs to is confirmed: `prepareIcon`
 * answers the `img:<id>` reference (the id is the PNG's hash, as the handler
 * computes it) and `store` adds it.
 */

export interface PreparedIcon {
  ref: string;
  store(): Promise<void>;
}

const SVG_ELEMENT = /<svg[\s>/]/i;

export async function prepareIcon(
  port: McpConfigPort,
  image: ImageInput,
): Promise<PreparedIcon> {
  const bytes = Buffer.from(image.base64, 'base64');
  const name = image.name ?? 'Imagen';
  let png: Buffer;
  if (image.mime === 'image/svg+xml') {
    if (bytes.length > MAX_SVG_BYTES)
      throw new ToolError('La imagen SVG pesa más de 1 MB');
    const text = bytes.toString('utf8');
    if (!SVG_ELEMENT.test(text))
      throw new ToolError('El archivo no es una imagen SVG');
    const drawn = await port.rasterizeSvg(text, CUSTOM_ICON_MAX_SIDE);
    if (!drawn) throw new ToolError('No se pudo dibujar la imagen SVG');
    png = drawn;
  } else {
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new ToolError('La imagen pesa más de 5 MB');
    const decoded = port.decodeImage(bytes);
    if (decoded.isEmpty())
      throw new ToolError('No se pudo leer la imagen (usa PNG, JPG o SVG)');
    const { width, height } = decoded.getSize();
    const target = scaledSize(width, height, CUSTOM_ICON_MAX_SIDE);
    png = (
      target.width === width && target.height === height
        ? decoded
        : decoded.resize({ ...target, quality: 'best' })
    ).toPNG();
  }
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  return {
    ref: customIconRef(contentId(png)),
    store: async () => {
      const stored = (await port.invoke('customIcons:addRasterized', {
        name,
        dataUrl,
      })) as { ok: boolean; error?: string };
      if (!stored.ok)
        throw new ToolError(stored.error ?? 'No se pudo guardar la imagen');
    },
  };
}
