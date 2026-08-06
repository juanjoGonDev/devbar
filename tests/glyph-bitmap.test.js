import { describe, it, expect } from 'vitest';
import { drawGlyphBGRA, markSDF } from '../src/glyph-bitmap.js';

// Helper: read premultiplied BGRA at (x,y) → [r,g,b,a].
function px(buf, size, x, y) {
  const i = (y * size + x) * 4;
  return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
}

describe('drawGlyphBGRA', () => {
  const size = 36;
  const green = [48, 209, 88];
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

describe('markSDF', () => {
  it('is negative inside the mark and positive well outside', () => {
    expect(markSDF(0.5 * 36, 0.5 * 36, 36)).toBeGreaterThan(-100); // sanity
    expect(markSDF(0.7 * 36, 0.5 * 36, 36)).toBeLessThanOrEqual(0); // on the bar
    expect(markSDF(0, 0, 36)).toBeGreaterThan(0); // corner is outside
  });
});
