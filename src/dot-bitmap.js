'use strict';

/**
 * dot-bitmap.js — pure pixel drawing for the menubar status dot. No Electron
 * import, so it's unit-testable in Node. Produces a raw BGRA buffer (the format
 * nativeImage.createFromBitmap expects on macOS). Hard edges only (alpha is 0
 * or 255) so we never deal with premultiplied-alpha surprises.
 *
 * The dot is a filled colour circle plus a contrasting ring so it stays visible
 * on any menubar background — the caller picks a light ring for dark
 * appearances and a dark ring for light ones (see tray-icon.js).
 */

// Fractions of the icon box.
const CORE_R = 0.36; // filled colour circle radius
const RING_R = 0.47; // outer ring radius (ring = between CORE_R and RING_R)

/**
 * @param {number} size  square side in px (e.g. 18 for @1x, 36 for @2x)
 * @param {[number,number,number]} rgb      core colour
 * @param {[number,number,number]} ringRgb  ring colour
 * @returns {Buffer} size*size*4 BGRA bytes
 */
function drawDotBGRA(size, rgb, ringRgb) {
  const buf = Buffer.alloc(size * size * 4); // zeroed → fully transparent
  const c = (size - 1) / 2;
  const coreR = size * CORE_R;
  const ringR = size * RING_R;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      let col = null;
      if (d <= coreR) col = rgb;
      else if (d <= ringR) col = ringRgb;
      if (col) {
        const i = (y * size + x) * 4;
        buf[i] = col[2]; // B
        buf[i + 1] = col[1]; // G
        buf[i + 2] = col[0]; // R
        buf[i + 3] = 255; // A (opaque)
      }
    }
  }
  return buf;
}

module.exports = { drawDotBGRA, CORE_R, RING_R };
