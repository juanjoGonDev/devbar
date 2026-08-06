'use strict';

/**
 * glyph-bitmap.js — draws the DevBar ">|" mark as a single-colour silhouette,
 * tinted by the caller (menubar state colour). Pure pixel maths, no Electron
 * import, so it's unit-testable in Node.
 *
 * Emits PREMULTIPLIED BGRA — the format nativeImage.createFromBitmap expects on
 * macOS. Channels are pre-scaled by coverage, so the anti-aliased edges render
 * without the bright halo you'd get from straight alpha.
 *
 * Same ">|" shape as assets/icon.svg, but with bolder strokes so it stays
 * legible at 18px in the menubar (the app icon uses thinner, elegant strokes).
 */

// Normalised (0..1) geometry inside the square icon box. Endpoint centres; the
// half-widths are the capsule (round-cap) radii.
const CHEVRON = [
  [0.32, 0.33], // top-left
  [0.53, 0.5], // tip (right, middle)
  [0.32, 0.67], // bottom-left
];
const CHEVRON_HW = 0.085;
const BAR_X = 0.7;
const BAR_Y0 = 0.33;
const BAR_Y1 = 0.67;
const BAR_HW = 0.075;

const SS = 3; // supersample grid per axis for edge anti-aliasing

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Smallest (distance − radius) over every capsule; <= 0 means the point is
// inside the mark.
function markSDF(px, py, size) {
  let best = Infinity;
  for (let k = 0; k < CHEVRON.length - 1; k++) {
    const a = CHEVRON[k];
    const b = CHEVRON[k + 1];
    const d =
      distToSeg(px, py, a[0] * size, a[1] * size, b[0] * size, b[1] * size) -
      CHEVRON_HW * size;
    if (d < best) best = d;
  }
  const db =
    distToSeg(
      px,
      py,
      BAR_X * size,
      BAR_Y0 * size,
      BAR_X * size,
      BAR_Y1 * size,
    ) -
    BAR_HW * size;
  return db < best ? db : best;
}

// Outline band width, as a fraction of the icon size. Wide enough to read as a
// ~1px contrast edge at 18px.
const OUTLINE = 0.06;

/**
 * @param {number} size  square side in px (e.g. 18 @1x, 36 @2x)
 * @param {[number,number,number]} rgb  fill (tint) colour
 * @param {[number,number,number]} [outlineRgb]  contrast outline colour; when
 *   omitted the mark is drawn fill-only. The outline lets a coloured (non-
 *   template) menubar icon stay legible on any background — the caller picks a
 *   dark outline for light appearances and a light one for dark.
 * @returns {Buffer} size*size*4 premultiplied BGRA bytes
 */
function drawGlyphBGRA(size, rgb, outlineRgb) {
  const buf = Buffer.alloc(size * size * 4); // zeroed → transparent
  const step = 1 / SS;
  const base = step / 2;
  const N = SS * SS;
  const outW = outlineRgb ? size * OUTLINE : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const d = markSDF(x + base + sx * step, y + base + sy * step, size);
          let col = null;
          if (d <= 0) col = rgb;
          else if (d <= outW) col = outlineRgb;
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
            cnt++;
          }
        }
      }
      if (!cnt) continue;
      // Averaging over ALL N samples (empties contribute 0) yields premultiplied
      // channels directly, so each channel stays <= alpha (no halo).
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b / N); // B
      buf[i + 1] = Math.round(g / N); // G
      buf[i + 2] = Math.round(r / N); // R
      buf[i + 3] = Math.round((255 * cnt) / N); // A
    }
  }
  return buf;
}

module.exports = { drawGlyphBGRA, markSDF };
