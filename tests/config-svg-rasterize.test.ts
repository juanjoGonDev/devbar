// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  rasterizeSvg,
  rasterSize,
  svgDataUrl,
} from '../renderer/config/svg-rasterize.js';

/**
 * jsdom has no canvas and loads no images, so both are faked: the fake
 * <img> "loads" with whatever natural size the test gives it, and the fake
 * 2D context records what was drawn.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>';
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo=';

interface Scene {
  natural: { width: number; height: number };
  loads: boolean;
  alpha: number;
  taint: boolean;
  noContext: boolean;
  sources: string[];
  drawn: number[][];
  canvases: { width: number; height: number }[];
}

let scene: Scene;

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    scene.sources.push(value);
    queueMicrotask(() => {
      if (!scene.loads) return this.onerror?.();
      this.naturalWidth = scene.natural.width;
      this.naturalHeight = scene.natural.height;
      this.onload?.();
    });
  }
}

describe('renderer/config/svg-rasterize.ts', () => {
  beforeEach(() => {
    scene = {
      natural: { width: 200, height: 100 },
      loads: true,
      alpha: 255,
      taint: false,
      noContext: false,
      sources: [],
      drawn: [],
      canvases: [],
    };
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement) {
        if (scene.noContext) return null;
        return {
          drawImage: (_img: unknown, ...rect: number[]) => {
            scene.canvases.push({ width: this.width, height: this.height });
            scene.drawn.push(rect);
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            data[data.length - 1] = scene.alpha;
            return { data };
          },
        } as unknown as CanvasRenderingContext2D;
      } as never,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      (type?: string) => {
        if (scene.taint) throw new DOMException('Tainted canvases', 'Security');
        return type === 'image/png' ? PNG_URL : 'data:,';
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('rasterSize', () => {
    it('scales the longest side to 64 px, keeping the aspect ratio', () => {
      expect(rasterSize(200, 100)).toEqual({ width: 64, height: 32 });
      expect(rasterSize(30, 120)).toEqual({ width: 16, height: 64 });
      expect(rasterSize(24, 24)).toEqual({ width: 64, height: 64 });
    });

    it('scales a small vector up, since it loses nothing', () => {
      expect(rasterSize(16, 8)).toEqual({ width: 64, height: 32 });
    });

    it('never collapses a side to zero', () => {
      expect(rasterSize(10_000, 1)).toEqual({ width: 64, height: 1 });
    });

    it('falls back to a 64 px square without a natural size', () => {
      expect(rasterSize(0, 0)).toEqual({ width: 64, height: 64 });
      expect(rasterSize(0, 50)).toEqual({ width: 64, height: 64 });
    });
  });

  it('encodes the text, unicode included, as a base64 SVG data URL', () => {
    const text = '<svg><title>Señal ✓</title></svg>';
    const url = svgDataUrl(text);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const body = url.slice('data:image/svg+xml;base64,'.length);
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe(text);
  });

  it.each([
    ['wide', { width: 200, height: 100 }, [0, 0, 64, 32]],
    ['tall', { width: 50, height: 400 }, [0, 0, 8, 64]],
    ['square', { width: 10, height: 10 }, [0, 0, 64, 64]],
    ['sizeless', { width: 0, height: 0 }, [0, 0, 64, 64]],
  ])(
    'draws a %s SVG through an <img> and exports a PNG',
    async (_label, natural, rect) => {
      scene.natural = natural;
      expect(await rasterizeSvg(SVG)).toEqual({ ok: true, dataUrl: PNG_URL });
      expect(scene.sources).toEqual([svgDataUrl(SVG)]);
      expect(scene.drawn).toEqual([rect]);
      expect(scene.canvases).toEqual([{ width: rect[2], height: rect[3] }]);
    },
  );

  it('reports an SVG the browser cannot load', async () => {
    scene.loads = false;
    expect(await rasterizeSvg('<svg')).toEqual({
      ok: false,
      error: 'No se pudo leer la imagen SVG: revisa que esté bien formada',
    });
  });

  it('reports a tainted canvas instead of throwing', async () => {
    scene.taint = true;
    expect(await rasterizeSvg(SVG)).toEqual({
      ok: false,
      error: 'No se pudo convertir la imagen SVG a PNG',
    });
  });

  it('refuses an image that comes out fully transparent', async () => {
    scene.alpha = 0;
    expect(await rasterizeSvg(SVG)).toEqual({
      ok: false,
      error: 'La imagen SVG está vacía o depende de recursos externos',
    });
  });

  it('reports a missing 2D context', async () => {
    scene.noContext = true;
    expect(await rasterizeSvg(SVG)).toEqual({
      ok: false,
      error: 'No se pudo convertir la imagen SVG a PNG',
    });
  });
});
