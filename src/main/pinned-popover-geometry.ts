import {
  clampXToWorkArea,
  trayPopoverHeight,
  type Rect,
} from './window-geometry.js';

/**
 * The arithmetic of a PINNED tray popover: one the user dragged or resized
 * away from the tray icon, which DevBar then keeps where they left it.
 *
 * Pure, like window-geometry.ts: the displays are passed in, so the cases that
 * cannot be reproduced by hand (a display unplugged, a resolution change, a
 * spot that straddles two monitors) are plain unit tests.
 *
 * Every number is in DIPs, Electron's default unit on every OS — a 150 %
 * Windows display reports and accepts the same logical rectangle, so a
 * stored rectangle survives a scale change.
 */

/** The popover's width when it hangs from the tray icon. */
export const TRAY_POPOVER_WIDTH = 410;
/** Below these the header and one group row no longer fit. */
export const TRAY_POPOVER_MIN_WIDTH = 320;
export const TRAY_POPOVER_MIN_HEIGHT = 160;
/** A restored popover must keep at least this much of itself on screen. */
const MIN_VISIBLE_FRACTION = 0.5;

/** What the store keeps: x/y relative to that display's work area. */
export interface PinnedPopover {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The slice of Electron's `Display` this module needs. */
export interface DisplayArea {
  id: number;
  workArea: Rect;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A stored record, or null when it is missing or was hand-edited wrong. */
export function normalizePinnedPopover(raw: unknown): PinnedPopover | null {
  if (!raw || typeof raw !== 'object') return null;
  const { displayId, x, y, width, height } = raw as Record<string, unknown>;
  if (![displayId, x, y, width, height].every(finite)) return null;
  const record = { displayId, x, y, width, height } as PinnedPopover;
  if (
    record.width < TRAY_POPOVER_MIN_WIDTH ||
    record.height < TRAY_POPOVER_MIN_HEIGHT
  )
    return null;
  return record;
}

/** The store record for a frame sitting on `display`. */
export function toPinnedPopover(
  frame: Rect,
  display: DisplayArea,
): PinnedPopover {
  return {
    displayId: display.id,
    x: Math.round(frame.x - display.workArea.x),
    y: Math.round(frame.y - display.workArea.y),
    width: Math.round(frame.width),
    height: Math.round(frame.height),
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Where a saved popover goes back to, or null when it cannot: its display is
 * gone, or less than half of it would land on any work area (a resolution
 * change, a monitor rearranged). Null means "anchor to the tray icon again".
 * A popover that passes is still pulled fully inside its own work area, and
 * shrunk to it if the display got smaller than the popover.
 */
export function restorePinnedBounds(
  saved: PinnedPopover,
  displays: readonly DisplayArea[],
): Rect | null {
  const display = displays.find((d) => d.id === saved.displayId);
  if (!display) return null;
  const area = display.workArea;
  const width = Math.min(saved.width, area.width);
  const height = Math.min(saved.height, area.height);
  const rect = { x: area.x + saved.x, y: area.y + saved.y, width, height };
  // Work areas never overlap, so the per-display overlaps add up to what is
  // actually visible — including the part past a seam between two monitors.
  const visible = displays.reduce(
    (sum, d) => sum + overlapArea(rect, d.workArea),
    0,
  );
  if (visible < MIN_VISIBLE_FRACTION * width * height) return null;
  return {
    x: clamp(rect.x, area.x, area.x + area.width - width),
    y: clamp(rect.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * The pinned popover's bounds for a new content height. The user's frame is
 * the ceiling: content shorter than it shrinks the window, never past it.
 * The edge that stays put follows the same rule as the tray-anchored popover
 * (trayPopoverBounds): a frame in the lower half of the work area keeps its
 * bottom edge, any other its top edge. The result stays inside the work area.
 */
export function pinnedAutoHeightBounds(
  frame: Rect,
  contentHeight: number,
  workArea: Rect,
): Rect {
  const height = Math.min(
    frame.height,
    trayPopoverHeight(contentHeight, workArea.height),
  );
  const centre = frame.y + frame.height / 2;
  const anchoredToBottom = centre > workArea.y + workArea.height / 2;
  const wantedY = anchoredToBottom ? frame.y + frame.height - height : frame.y;
  return {
    x: clampXToWorkArea(frame.x, frame.width, workArea),
    y: clamp(wantedY, workArea.y, workArea.y + workArea.height - height),
    width: frame.width,
    height,
  };
}

/**
 * The user's frame after one of their own bounds changes. A move shifts the
 * frame by the drag delta, so the height they chose survives a drag of a
 * popover that auto-height had shrunk; a resize (the size changed) makes the
 * new bounds the frame. The first change of all starts from the bounds.
 */
export function nextPinnedFrame(
  frame: Rect | null,
  previous: Rect,
  current: Rect,
): Rect {
  const resized =
    current.width !== previous.width || current.height !== previous.height;
  if (!frame || resized) return { ...current };
  return {
    x: frame.x + current.x - previous.x,
    y: frame.y + current.y - previous.y,
    width: frame.width,
    height: frame.height,
  };
}
