/**
 * Pure pan/zoom math for the pipeline canvas. The world layer is drawn with
 * `translate(x, y) scale(zoom)`, so a world point `p` lands on screen at
 * `p * zoom + (x, y)` — screen coordinates being relative to the canvas.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
/** How far fitting may zoom a small graph in: a little, never a blow-up. */
export const MAX_FIT_ZOOM = 1.25;
/** One click of the zoom buttons multiplies or divides by this. */
const STEP_FACTOR = 1.2;
/** How strongly a wheel delta zooms: `exp(-delta * WHEEL_RATE)`. */
const WHEEL_RATE = 0.01;

export function clampZoom(zoom: number): number {
  // Rounded to whole percentages so repeated steps never drift into 69.99%.
  const rounded = Math.round(zoom * 100) / 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded));
}

export function toWorld(view: Viewport, sx: number, sy: number): Point {
  return { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
}

export function toScreen(view: Viewport, point: Point): Point {
  return { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y };
}

/**
 * `view` at `zoom`, keeping the world point under the screen point
 * (`sx`, `sy`) where it was. The same object back when nothing changes.
 */
export function zoomAt(
  view: Viewport,
  zoom: number,
  sx: number,
  sy: number,
): Viewport {
  const next = clampZoom(zoom);
  if (next === view.zoom) return view;
  const anchor = toWorld(view, sx, sy);
  return { x: sx - anchor.x * next, y: sy - anchor.y * next, zoom: next };
}

/** Ctrl/Cmd + wheel and trackpad pinch (which arrives as a ctrl wheel). */
export function wheelZoom(
  view: Viewport,
  deltaY: number,
  sx: number,
  sy: number,
): Viewport {
  return zoomAt(view, view.zoom * Math.exp(-deltaY * WHEEL_RATE), sx, sy);
}

/** One click of zoom-in (`1`) or zoom-out (`-1`), around (`sx`, `sy`). */
export function stepZoom(
  view: Viewport,
  direction: -1 | 1,
  sx: number,
  sy: number,
): Viewport {
  const factor = direction === 1 ? STEP_FACTOR : 1 / STEP_FACTOR;
  return zoomAt(view, view.zoom * factor, sx, sy);
}

export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { x: view.x + dx, y: view.y + dy, zoom: view.zoom };
}

/**
 * The view that shows all of `bounds` inside `area` (canvas coordinates),
 * centred, with `padding` screen pixels around it. It zooms a small pipeline
 * in up to `MAX_FIT_ZOOM` to use the room, never more, nor under the minimum. Null
 * while the area has no size: a hidden canvas cannot be fitted yet.
 */
export function fitView(
  bounds: Rect,
  area: Rect,
  padding = 40,
): Viewport | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const usableW = Math.max(1, area.width - padding * 2);
  const usableH = Math.max(1, area.height - padding * 2);
  const fit = Math.min(
    usableW / Math.max(1, bounds.width),
    usableH / Math.max(1, bounds.height),
  );
  // Rounded down, so the rounding never pushes the graph past the edge.
  const zoom = Math.min(MAX_FIT_ZOOM, clampZoom(Math.floor(fit * 100) / 100));
  return {
    x: area.x + (area.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: area.y + (area.height - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

/** `view` panned so `point` sits at the centre of an area of that size. */
export function centerOn(
  view: Viewport,
  point: Point,
  area: { width: number; height: number },
): Viewport {
  return {
    x: area.width / 2 - point.x * view.zoom,
    y: area.height / 2 - point.y * view.zoom,
    zoom: view.zoom,
  };
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
