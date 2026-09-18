type RGB = readonly [number, number, number];
const CHEVRON: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [0.32, 0.33],
  [0.53, 0.5],
  [0.32, 0.67],
];
const CHEVRON_HW = 0.085,
  BAR_X = 0.7,
  BAR_Y0 = 0.33,
  BAR_Y1 = 0.67,
  BAR_HW = 0.075,
  SS = 3,
  OUTLINE = 0.06;
// "Something new" dot, parked in the top-right corner clear of the chevron.
// Kept inside the box with room for its outline ring (cx + r + OUTLINE <= 1),
// otherwise the ring clips against the edge and the dot reads as a wedge.
const BADGE_CX = 0.79,
  BADGE_CY = 0.21,
  BADGE_R = 0.14;
// Count bubble (win/linux, where tray titles don't render): a larger
// top-right badge carrying the error/warning count in white digits. The
// tray slot is a fixed square owned by the OS, so the number has to live
// inside the icon — sized as large as the outline ring allows
// (cx + r + OUTLINE <= 1) while still clearing the box edges.
const COUNT_CX = 0.6,
  COUNT_CY = 0.34,
  COUNT_R = 0.28;
// 3x5 bitmap digits (row-major, bit 2 = leftmost) for the count bubble.
const DIGITS: Record<string, readonly number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 3, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 2, 2],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0],
};
/**
 * The label drawn inside the count bubble: at most two digits, anything
 * bigger reads as "99+" (three clusters is the most that fits).
 */
export function countLabel(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}
function distToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax,
    dy = by - ay,
    len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function markSDF(px: number, py: number, size: number): number {
  let best = Infinity;
  for (let k = 0; k < CHEVRON.length - 1; k++) {
    const a = CHEVRON[k],
      b = CHEVRON[k + 1];
    if (!a || !b) continue;
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
/** Signed distance to the update badge; negative inside the dot. */
export function badgeSDF(px: number, py: number, size: number): number {
  return (
    Math.hypot(px - BADGE_CX * size, py - BADGE_CY * size) - BADGE_R * size
  );
}

/** Signed distance to the count bubble; negative inside. */
export function countBubbleSDF(px: number, py: number, size: number): number {
  return (
    Math.hypot(px - COUNT_CX * size, py - COUNT_CY * size) - COUNT_R * size
  );
}

export function drawGlyphBGRA(
  size: number,
  rgb: RGB,
  outlineRgb?: RGB,
  badgeRgb?: RGB,
  count = 0,
): Buffer {
  const buf = Buffer.alloc(size * size * 4),
    step = 1 / SS,
    base = step / 2,
    N = SS * SS,
    outW = outlineRgb ? size * OUTLINE : 0;
  // Count bubble layout: the label's 3x5 digit clusters, centered in the
  // bubble. Rasterized once into a mask; the supersampled loop below just
  // samples it (a point inside the bubble on a digit pixel → white).
  const label = countLabel(count);
  const digitMask = new Uint8Array(size * size);
  if (label && badgeRgb) {
    const n = label.length,
      unitsW = 3 * n + (n - 1),
      unit = Math.min(
        (2 * COUNT_R * size * 0.88) / unitsW,
        (2 * COUNT_R * size * 0.78) / 5,
        // The two terms above bound the label's WIDTH and HEIGHT against
        // the bubble's diameter, but the bubble is a CIRCLE: the corners
        // of the fattened label block sit further out than either
        // half-extent. For two digits (unitsW=7, width-limited) that
        // corner landed at 0.3107*size against a 0.28*size radius — 11%
        // outside, and the `bd <= 0` gate on onDigit below drops those
        // samples back to the badge colour, clipping the digits. This
        // third term bounds the corner DISTANCE itself (0.08 is the
        // fatten ratio just below). Inert for one and three digits, where
        // the terms above already win.
        (COUNT_R * size) / Math.hypot(unitsW / 2 + 0.08, 5 / 2 + 0.08),
      ),
      // Bold the 3x5 strokes: at tray size a bare 1px stroke reads as a
      // pinprick, so each digit cell is expanded slightly in all directions.
      fatten = 0.08 * unit,
      x0 = COUNT_CX * size - (unit * unitsW) / 2,
      y0 = COUNT_CY * size - (unit * 5) / 2;
    for (let i = 0; i < n; i++) {
      const ch = label[i];
      const glyph = ch ? DIGITS[ch] : undefined;
      if (!glyph) continue;
      for (let row = 0; row < 5; row++) {
        const bits = glyph[row] ?? 0;
        for (let col = 0; col < 3; col++) {
          if (!(bits & (4 >> col))) continue;
          const rx = x0 + (i * 4 + col) * unit,
            ry = y0 + row * unit;
          for (
            let y = Math.max(0, Math.floor(ry - fatten));
            y < size && y < Math.ceil(ry + unit + fatten);
            y++
          )
            for (
              let x = Math.max(0, Math.floor(rx - fatten));
              x < size && x < Math.ceil(rx + unit + fatten);
              x++
            )
              digitMask[y * size + x] = 1;
        }
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        count = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + base + sx * step,
            py = y + base + sy * step;
          const d = markSDF(px, py, size);
          // The badge sits on top of the mark, keeping its outline ring, so it
          // stays legible even when the mark itself is tinted red. With a
          // count, the small dot becomes the count bubble (white digits).
          const bd = badgeRgb
            ? label
              ? countBubbleSDF(px, py, size)
              : badgeSDF(px, py, size)
            : Infinity;
          const onDigit =
            label && bd <= 0
              ? digitMask[
                  Math.min(size - 1, Math.floor(py)) * size +
                    Math.min(size - 1, Math.floor(px))
                ] === 1
              : false;
          const color = onDigit
            ? [255, 255, 255]
            : bd <= 0
              ? badgeRgb
              : bd <= outW
                ? outlineRgb
                : d <= 0
                  ? rgb
                  : d <= outW
                    ? outlineRgb
                    : undefined;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            count++;
          }
        }
      if (!count) continue;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b / N);
      buf[i + 1] = Math.round(g / N);
      buf[i + 2] = Math.round(r / N);
      buf[i + 3] = Math.round((255 * count) / N);
    }
  }
  return buf;
}
