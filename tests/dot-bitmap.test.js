import { describe, it, expect } from 'vitest';
import { drawDotBGRA } from '../src/dot-bitmap.js';

// Helper: read BGRA at (x,y) → [r,g,b,a].
function px(buf, size, x, y) {
  const i = (y * size + x) * 4;
  return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
}

describe('drawDotBGRA', () => {
  const size = 36;
  const core = [48, 209, 88]; // green
  const ring = [255, 255, 255]; // white
  const buf = drawDotBGRA(size, core, ring);

  it('produces a size*size*4 BGRA buffer', () => {
    expect(buf).toHaveLength(size * size * 4);
  });

  it('fills the centre with the core colour (opaque)', () => {
    const c = Math.floor((size - 1) / 2);
    expect(px(buf, size, c, c)).toEqual([...core, 255]);
  });

  it('leaves the corners transparent', () => {
    expect(px(buf, size, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(buf, size, size - 1, size - 1)).toEqual([0, 0, 0, 0]);
  });

  it('draws the ring colour just outside the core', () => {
    // The ring sits between CORE_R (0.36) and RING_R (0.47) of the size along
    // the horizontal from centre — sample at ~0.42.
    const c = (size - 1) / 2;
    const x = Math.round(c + size * 0.42);
    expect(px(buf, size, x, Math.round(c))).toEqual([...ring, 255]);
  });

  it('every pixel is fully opaque or fully transparent (no premult surprises)', () => {
    for (let i = 3; i < buf.length; i += 4) {
      expect(buf[i] === 0 || buf[i] === 255).toBe(true);
    }
  });
});
