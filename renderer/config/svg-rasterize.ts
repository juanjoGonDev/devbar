import { CUSTOM_ICON_MAX_SIDE } from '../../src/custom-icons.js';

/**
 * Turns an uploaded SVG into the PNG that is actually stored. `nativeImage`
 * in main cannot decode SVG, so the config renderer does it:
 *
 * - the text is loaded as an `<img>` from a `data:image/svg+xml` URL, which
 *   never runs the SVG's scripts and never fetches its external resources
 *   (config.html's CSP allows `img-src 'self' data:`); the SVG is never put
 *   in the DOM as markup;
 * - it is drawn on a canvas whose longest side is 64 px and exported with
 *   `toDataURL('image/png')`. Main then validates and stores that PNG like
 *   any other upload; the SVG itself is dropped here.
 */

export type RasterizeResult =
  { ok: true; dataUrl: string } | { ok: false; error: string };

const LOAD_ERROR =
  'No se pudo leer la imagen SVG: revisa que esté bien formada';
const EXPORT_ERROR = 'No se pudo convertir la imagen SVG a PNG';
const EMPTY_ERROR = 'La imagen SVG está vacía o depende de recursos externos';

/**
 * The canvas size for an SVG of `width × height`: longest side `max`, aspect
 * ratio kept. A vector scales up losslessly, so a small one is enlarged too.
 * Without a natural size (no width, height or viewBox) it is a `max` square.
 */
export function rasterSize(
  width: number,
  height: number,
  max = CUSTOM_ICON_MAX_SIDE,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: max, height: max };
  const factor = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** The SVG text as a base64 data URL; UTF-8 safe, unlike a bare `btoa`. */
export function svgDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked: spreading a 1 MB array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function hasVisiblePixel(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
}

export async function rasterizeSvg(text: string): Promise<RasterizeResult> {
  const img = await loadImage(svgDataUrl(text));
  if (!img) return { ok: false, error: LOAD_ERROR };
  const { width, height } = rasterSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, error: EXPORT_ERROR };
  try {
    ctx.drawImage(img, 0, 0, width, height);
    // Cheap at 64 × 64, and it catches an SVG whose content was all
    // external (blocked) resources or nothing at all.
    if (!hasVisiblePixel(ctx.getImageData(0, 0, width, height).data))
      return { ok: false, error: EMPTY_ERROR };
    return { ok: true, dataUrl: canvas.toDataURL('image/png') };
  } catch {
    // A tainted canvas throws on getImageData / toDataURL.
    return { ok: false, error: EXPORT_ERROR };
  }
}
