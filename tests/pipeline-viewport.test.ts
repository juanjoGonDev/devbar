import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerOn,
  clampZoom,
  fitView,
  formatZoom,
  panBy,
  stepZoom,
  toWorld,
  wheelZoom,
  zoomAt,
} from '../renderer/pipeline/viewport.js';

describe('renderer/pipeline/viewport.ts', () => {
  describe('clampZoom', () => {
    it('keeps the zoom inside 25%–200%', () => {
      expect(clampZoom(0.1)).toBe(MIN_ZOOM);
      expect(clampZoom(5)).toBe(MAX_ZOOM);
      expect(MIN_ZOOM).toBe(0.25);
      expect(MAX_ZOOM).toBe(2);
    });

    it('lands on whole percentages', () => {
      expect(clampZoom(0.7049)).toBe(0.7);
    });
  });

  describe('zoomAt', () => {
    it('keeps the world point under the cursor where it was', () => {
      const view = { x: 30, y: -10, zoom: 1 };
      const before = toWorld(view, 200, 120);
      const next = zoomAt(view, 1.5, 200, 120);
      expect(next.zoom).toBe(1.5);
      const after = toWorld(next, 200, 120);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    });

    it('returns the same view when the zoom is already at a limit', () => {
      const view = { x: 0, y: 0, zoom: MAX_ZOOM };
      expect(zoomAt(view, 3, 10, 10)).toBe(view);
    });
  });

  describe('wheelZoom', () => {
    it('zooms in for a negative delta and out for a positive one', () => {
      const view = { x: 0, y: 0, zoom: 1 };
      expect(wheelZoom(view, -50, 0, 0).zoom).toBeGreaterThan(1);
      expect(wheelZoom(view, 50, 0, 0).zoom).toBeLessThan(1);
    });
  });

  describe('stepZoom', () => {
    it('steps by a fifth and stops at the limits', () => {
      const view = { x: 0, y: 0, zoom: 1 };
      expect(stepZoom(view, 1, 0, 0).zoom).toBe(1.2);
      let out = view;
      for (let i = 0; i < 20; i++) out = stepZoom(out, -1, 0, 0);
      expect(out.zoom).toBe(MIN_ZOOM);
    });
  });

  describe('panBy', () => {
    it('moves the view by screen pixels', () => {
      expect(panBy({ x: 1, y: 2, zoom: 0.5 }, 10, -4)).toEqual({
        x: 11,
        y: -2,
        zoom: 0.5,
      });
    });
  });

  describe('fitView', () => {
    it('centres a small graph at 100% instead of blowing it up', () => {
      const view = fitView(
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 0, y: 0, width: 500, height: 300 },
      );
      expect(view).toEqual({ x: 200, y: 125, zoom: 1 });
    });

    it('shrinks a wide graph to fit the area, padding included', () => {
      const view = fitView(
        { x: 0, y: 0, width: 2000, height: 100 },
        { x: 0, y: 0, width: 1080, height: 600 },
        40,
      );
      expect(view?.zoom).toBe(0.5);
    });

    it('never shrinks below the minimum zoom', () => {
      const view = fitView(
        { x: 0, y: 0, width: 100_000, height: 100 },
        { x: 0, y: 0, width: 500, height: 300 },
      );
      expect(view?.zoom).toBe(MIN_ZOOM);
    });

    it('fits inside an area that does not start at the left edge', () => {
      const view = fitView(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 250, y: 0, width: 500, height: 300 },
        0,
      );
      expect(view?.x).toBe(450);
    });

    it('gives up on an area with no size yet', () => {
      expect(
        fitView(
          { x: 0, y: 0, width: 100, height: 100 },
          { x: 0, y: 0, width: 0, height: 0 },
        ),
      ).toBeNull();
    });
  });

  describe('centerOn', () => {
    it('puts a world point at the centre of the area', () => {
      const view = centerOn(
        { x: 0, y: 0, zoom: 2 },
        { x: 100, y: 50 },
        {
          width: 400,
          height: 200,
        },
      );
      expect(view).toEqual({ x: 0, y: 0, zoom: 2 });
    });
  });

  it('formats the zoom as a percentage', () => {
    expect(formatZoom(0.25)).toBe('25%');
    expect(formatZoom(1.2)).toBe('120%');
  });
});
