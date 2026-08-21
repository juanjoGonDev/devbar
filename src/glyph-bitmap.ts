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

export function drawGlyphBGRA(
  size: number,
  rgb: RGB,
  outlineRgb?: RGB,
  badgeRgb?: RGB,
): Buffer {
  const buf = Buffer.alloc(size * size * 4),
    step = 1 / SS,
    base = step / 2,
    N = SS * SS,
    outW = outlineRgb ? size * OUTLINE : 0;
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
          // stays legible even when the mark itself is tinted red.
          const bd = badgeRgb ? badgeSDF(px, py, size) : Infinity;
          const color =
            bd <= 0
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
