import { describe, it, expect } from 'vitest';
import {
  badgeSDF,
  countBubbleSDF,
  countLabel,
  drawGlyphBGRA,
  markSDF,
} from '../src/glyph-bitmap.js';
type RGB = readonly [number, number, number];

// Helper: read premultiplied BGRA at (x,y) → [r,g,b,a].
function px(
  buf: Buffer,
  size: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * size + x) * 4;
  return [buf[i + 2] ?? 0, buf[i + 1] ?? 0, buf[i] ?? 0, buf[i + 3] ?? 0];
}

describe('drawGlyphBGRA', () => {
  const size = 36;
  const green: RGB = [48, 209, 88];
  const buf = drawGlyphBGRA(size, green);

  it('produces a size*size*4 buffer', () => {
    expect(buf).toHaveLength(size * size * 4);
  });

  it('leaves the corners transparent', () => {
    expect(px(buf, size, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(buf, size, size - 1, size - 1)).toEqual([0, 0, 0, 0]);
  });

  it('draws the tint on the chevron top-left arm', () => {
    // markSDF confirms (0.32,0.33) is inside the mark; that pixel must be opaque
    // and carry the (premultiplied) tint.
    const x = Math.round(0.32 * size);
    const y = Math.round(0.33 * size);
    const [r, g, b, a] = px(buf, size, x, y);
    expect(a).toBe(255);
    expect([r, g, b]).toEqual(green); // full coverage → premult == straight
  });

  it('draws the bar (right side, middle)', () => {
    const [, , , a] = px(
      buf,
      size,
      Math.round(0.7 * size),
      Math.round(0.5 * size),
    );
    expect(a).toBe(255);
  });

  it('keeps premultiplied channels <= alpha (no halo)', () => {
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      expect(buf[i]).toBeLessThanOrEqual(a);
      expect(buf[i + 1]).toBeLessThanOrEqual(a);
      expect(buf[i + 2]).toBeLessThanOrEqual(a);
    }
  });
});

describe('drawGlyphBGRA with outline', () => {
  const size = 36;
  const green: RGB = [48, 209, 88];
  const outline: RGB = [28, 28, 30];
  const buf = drawGlyphBGRA(size, green, outline);

  it('rings the mark with the outline colour just outside the fill', () => {
    // Step outward from the bar edge until we leave the fill; the first opaque
    // band there must be the (dark) outline, not the (green) fill.
    let found = false;
    const y = Math.round(0.5 * size);
    for (let x = Math.round(0.7 * size); x < size; x++) {
      const [r, g, b, a] = px(buf, size, x, y);
      if (a === 255 && g < 120 && r < 120 && b < 120) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('still keeps premultiplied channels <= alpha', () => {
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      expect(buf[i]).toBeLessThanOrEqual(a);
      expect(buf[i + 1]).toBeLessThanOrEqual(a);
      expect(buf[i + 2]).toBeLessThanOrEqual(a);
    }
  });
});

describe('markSDF', () => {
  it('is negative inside the mark and positive well outside', () => {
    expect(markSDF(0.5 * 36, 0.5 * 36, 36)).toBeLessThanOrEqual(0); // centre is inside
    expect(markSDF(0.7 * 36, 0.5 * 36, 36)).toBeLessThanOrEqual(0); // on the bar
    expect(markSDF(0, 0, 36)).toBeGreaterThan(0); // corner is outside
  });
});

describe('badgeSDF', () => {
  const size = 36;

  it('is negative at the badge centre and positive at the mark', () => {
    expect(badgeSDF(0.79 * size, 0.21 * size, size)).toBeLessThan(0);
    // The chevron's top-left arm must sit well outside the dot.
    expect(badgeSDF(0.32 * size, 0.33 * size, size)).toBeGreaterThan(0);
  });

  it('scales with the icon size', () => {
    expect(badgeSDF(0.79 * 18, 0.21 * 18, 18)).toBeLessThan(0);
    expect(badgeSDF(0.79 * 72, 0.21 * 72, 72)).toBeLessThan(0);
  });
});

describe('drawGlyphBGRA with an update badge', () => {
  const size = 36;
  const grey: RGB = [152, 152, 157];
  const outline: RGB = [28, 28, 30];
  const badge: RGB = [255, 59, 48];
  const plain = drawGlyphBGRA(size, grey, outline);
  const badged = drawGlyphBGRA(size, grey, outline, badge);

  it('paints the badge colour at the badge centre', () => {
    const [r, g, b, a] = px(
      badged,
      size,
      Math.round(0.79 * size),
      Math.round(0.21 * size),
    );
    expect(a).toBe(255);
    expect([r, g, b]).toEqual(badge);
  });

  it('paints a corner that the badge-less mark leaves empty', () => {
    // Inside the dot but clear of the mark and its outline ring, so the only
    // thing that can put ink here is the badge.
    const x = Math.round(0.86 * size);
    const y = Math.round(0.12 * size);
    expect(px(plain, size, x, y)[3]).toBe(0);
    expect(px(badged, size, x, y)[3]).toBe(255);
  });

  it('keeps the mark itself intact', () => {
    const [, , , a] = px(
      badged,
      size,
      Math.round(0.32 * size),
      Math.round(0.33 * size),
    );
    expect(a).toBe(255);
  });

  it('stays visible on an error-red mark thanks to the outline ring', () => {
    // Between the red mark and the red dot there must be a dark outline band.
    const red: RGB = [255, 69, 58];
    const buf = drawGlyphBGRA(size, red, outline, badge);
    let sawOutline = false;
    const x = Math.round(0.79 * size);
    for (let y = Math.round(0.21 * size); y < size; y++) {
      const [r, g, b, a] = px(buf, size, x, y);
      if (a === 255 && r < 120 && g < 120 && b < 120) {
        sawOutline = true;
        break;
      }
    }
    expect(sawOutline).toBe(true);
  });

  it('still keeps premultiplied channels <= alpha', () => {
    for (let i = 0; i < badged.length; i += 4) {
      const a = badged[i + 3];
      expect(badged[i]).toBeLessThanOrEqual(a);
      expect(badged[i + 1]).toBeLessThanOrEqual(a);
      expect(badged[i + 2]).toBeLessThanOrEqual(a);
    }
  });
});

describe('countLabel', () => {
  it('is empty for zero or negative counts', () => {
    expect(countLabel(0)).toBe('');
    expect(countLabel(-3)).toBe('');
  });

  it('passes counts up to 99 through', () => {
    expect(countLabel(1)).toBe('1');
    expect(countLabel(14)).toBe('14');
    expect(countLabel(99)).toBe('99');
  });

  it('caps larger counts at 99+', () => {
    expect(countLabel(100)).toBe('99+');
    expect(countLabel(1234)).toBe('99+');
  });
});

describe('countBubbleSDF', () => {
  const size = 36;

  it('is negative at the bubble centre and positive at the corner', () => {
    expect(countBubbleSDF(0.6 * size, 0.34 * size, size)).toBeLessThan(0);
    expect(countBubbleSDF(0, 0, size)).toBeGreaterThan(0);
  });
});

describe('drawGlyphBGRA with a count bubble', () => {
  const size = 36;
  const red: RGB = [255, 69, 58];
  const outline: RGB = [28, 28, 30];
  const badge: RGB = [255, 59, 48];
  const plain = drawGlyphBGRA(size, red, outline, badge, 0);
  const counted = drawGlyphBGRA(size, red, outline, badge, 14);

  // White (digit) pixels inside the bubble region, clear of the mark.
  function whitePixels(buf: Buffer): number {
    let white = 0;
    for (let y = Math.floor(0.16 * size); y < 0.52 * size; y++)
      for (let x = Math.floor(0.33 * size); x < 0.87 * size; x++) {
        const [r, g, b, a] = px(buf, size, x, y);
        if (a > 200 && r > 240 && g > 240 && b > 240) white++;
      }
    return white;
  }

  it('paints the bubble red above the digits, inside the bubble', () => {
    const [r, g, b, a] = px(
      counted,
      size,
      Math.round(0.6 * size),
      Math.round(0.1 * size),
    );
    expect(a).toBe(255);
    expect([r, g, b]).toEqual(badge);
  });

  it('draws white digits inside the bubble', () => {
    expect(whitePixels(counted)).toBeGreaterThan(10);
  });

  it('draws no digits when the count is zero (small update dot instead)', () => {
    expect(whitePixels(plain)).toBe(0);
  });

  it('renders more digit pixels for two digits than for one', () => {
    const two = whitePixels(drawGlyphBGRA(size, red, outline, badge, 14));
    const one = whitePixels(drawGlyphBGRA(size, red, outline, badge, 7));
    expect(two).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(0);
  });

  it('keeps the mark intact and the premultiplied invariant', () => {
    const [, , , a] = px(
      counted,
      size,
      Math.round(0.32 * size),
      Math.round(0.33 * size),
    );
    expect(a).toBe(255);
    for (let i = 0; i < counted.length; i += 4) {
      const alpha = counted[i + 3];
      expect(counted[i]).toBeLessThanOrEqual(alpha);
      expect(counted[i + 1]).toBeLessThanOrEqual(alpha);
      expect(counted[i + 2]).toBeLessThanOrEqual(alpha);
    }
  });
});

describe('count bubble — the label must fit inside the CIRCLE, not its box', () => {
  const red: RGB = [255, 69, 58];
  const outline: RGB = [28, 28, 30];
  const badge: RGB = [255, 59, 48];

  /**
   * How wide the topmost and bottommost white (digit) rows are, relative
   * to the widest one.
   *
   * "88" is the probe: the 3x5 `8` carries a FULL 3-wide bar on its top,
   * middle and bottom rows, so those three rows of the rendered block are
   * analytically the same width. Anything narrower at the top or bottom
   * is the block's CORNERS being cut.
   */
  function barRatios(
    size: number,
    count: number,
  ): { top: number; bottom: number } {
    const buf = drawGlyphBGRA(size, red, outline, badge, count);
    const widths: number[] = [];
    for (let y = 0; y < size; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < size; x++) {
        const [r, g, b, a] = px(buf, size, x, y);
        if (a > 200 && r > 240 && g > 240 && b > 240) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first >= 0) widths.push(last - first + 1);
    }
    const max = Math.max(...widths);
    return {
      top: (widths[0] ?? 0) / max,
      bottom: (widths[widths.length - 1] ?? 0) / max,
    };
  }

  // Bounding the label by the bubble's WIDTH and HEIGHT does not bound
  // its corners: the bubble is a circle, and for two digits the fattened
  // block's corner sat at 0.3107*size against a 0.28*size radius — 11%
  // outside. drawGlyphBGRA gates `onDigit` on `bd <= 0`, so every sample
  // beyond the circle falls through to the badge colour and the top and
  // bottom bars are cut short at both ends.
  it('keeps the two-digit top and bottom bars full width', () => {
    // 120px: far enough above the Math.floor/ceil snapping in digitMask
    // that this measures geometry alone. Clipped it is 0.81; bounded by
    // the corner distance, 0.96.
    const { top, bottom } = barRatios(120, 88);
    expect(top).toBeGreaterThan(0.95);
    expect(bottom).toBeGreaterThan(0.95);
  });

  it('holds at a real tray size too', () => {
    // Clipped: 0.68. Bounded: 0.88. The remaining gap is that pixel
    // snapping, which already clips "99+" today — a separate, larger
    // change, deliberately not chased here.
    expect(barRatios(36, 88).top).toBeGreaterThan(0.8);
  });

  it('leaves the one- and three-digit labels untouched', () => {
    // The width/height terms already win for those, so the radial bound
    // is inert: `7` (top bar full, bottom a single stem) and `99+` (the
    // `+` has no ink on the outer rows) keep their glyph shapes.
    expect(barRatios(120, 7).top).toBe(1);
    expect(barRatios(120, 100).top).toBeCloseTo(0.65, 1);
  });
});
