/**
 * Where every window main.ts opens ends up on screen, as arithmetic over a
 * work area rather than over live `screen` readings. The Electron side stays
 * in `main.ts` (which display is "active", what the tray icon's bounds are);
 * everything that decides a number lives here so it can be exercised for the
 * multi-monitor and panel-position cases that are impossible to reproduce by
 * hand.
 */

/** The shape `Electron.Rectangle` and `Display.workArea` share. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Which edge of the display the taskbar/panel sits on. */
export type TaskbarSide = 'top' | 'bottom' | 'left' | 'right';

export type TrayPosition =
  'trayCenter' | 'trayBottomCenter' | 'trayLeft' | 'trayRight';

/**
 * Size AND place on the active display (focused window's / cursor's screen),
 * not the primary one — otherwise opening a window (e.g. a log viewer) from a
 * config window living on a second display makes macOS jump Spaces and the
 * config window seems to vanish.
 */
export function adaptiveSize(
  workArea: Rect,
  maxW: number,
  maxH: number,
  marginW = 60,
  marginH = 100,
): Placement {
  const width = Math.max(420, Math.min(maxW, workArea.width - marginW));
  const height = Math.max(360, Math.min(maxH, workArea.height - marginH));
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

const BANNER_WIDTH = 360;
const BANNER_HEIGHT = 76;
const BANNER_MARGIN = 12;

/** Top-right corner of the active display's work area. */
export function bannerBounds(workArea: Rect): Placement {
  return {
    width: BANNER_WIDTH,
    height: BANNER_HEIGHT,
    x: workArea.x + workArea.width - BANNER_WIDTH - BANNER_MARGIN,
    y: workArea.y + BANNER_MARGIN,
  };
}

/**
 * The popover grows / shrinks to fit the height the renderer measured, clamped
 * against the available work area so an extremely tall list doesn't push past
 * the screen edge.
 */
export function trayPopoverHeight(
  contentHeight: number,
  workAreaHeight: number,
): number {
  const maxH = Math.max(280, workAreaHeight - 80);
  return Math.max(160, Math.min(Math.ceil(contentHeight) + 4, maxH));
}

/**
 * Where the popover goes when its content height changes while it is open.
 *
 * Electron's setSize keeps the top-left corner fixed, which is only right when
 * the popover hangs from a top bar (macOS, a top Linux panel). Above a bottom
 * taskbar (Windows' default, most bottom Linux panels) it grew DOWNWARD,
 * behind the taskbar and off the screen, and shrank into a window floating
 * above it — until the next show, when menubar recomputed the position from
 * the new size. So the edge nearest the tray stays put: a popover sitting in
 * the lower half of the work area keeps its bottom edge, any other keeps its
 * top edge. The result is then pulled fully inside the work area, which also
 * covers a side taskbar with the icon low on it.
 */
export function trayPopoverBounds(
  current: Rect,
  contentHeight: number,
  workArea: Rect,
): Rect {
  const height = trayPopoverHeight(contentHeight, workArea.height);
  const centre = current.y + current.height / 2;
  const anchoredToBottom = centre > workArea.y + workArea.height / 2;
  const wantedY = anchoredToBottom
    ? current.y + current.height - height
    : current.y;
  const y = Math.max(
    workArea.y,
    Math.min(wantedY, workArea.y + workArea.height - height),
  );
  return {
    x: clampXToWorkArea(current.x, current.width, workArea),
    y,
    width: current.width,
    height,
  };
}

/** Room for one panel at each end of the display: a 56px panel is generous. */
const UNREPORTED_PANEL_ALLOWANCE = 56;
/** Ceiling: never taller than three quarters of the display. */
const UNREPORTED_MAX_DISPLAY_FRACTION = 0.75;

type LinuxDisplay = { workArea: Rect; bounds: Rect };

/**
 * Whether the window manager published a reserved area (a panel): with none,
 * Electron reports the whole display as the work area. That is what native
 * Wayland always does, and X11 WMs/panels without _NET_WORKAREA or struts.
 */
function workAreaReported({ workArea, bounds }: LinuxDisplay): boolean {
  return (
    workArea.x !== bounds.x ||
    workArea.y !== bounds.y ||
    workArea.width !== bounds.width ||
    workArea.height !== bounds.height
  );
}

/**
 * The work area to size the tray popover against on Linux. A reported work
 * area is used as is. An unreported one is the whole display, so a popover
 * sized to it slides under the panel: without the real panel geometry, the
 * height is capped at the smallest of the work area, the display minus a 56px
 * panel at each end, and 75 % of the display. The capped area sits at the
 * display end `near` (the tray icon, else the popover) is on, so on X11 the
 * popover stays next to the icon, and always inside the display. Native
 * Wayland ignores the position anyway; only the height matters there.
 */
export function safeLinuxWorkArea(display: LinuxDisplay, near: Rect): Rect {
  if (workAreaReported(display)) return display.workArea;
  const { workArea, bounds } = display;
  // ponytail: a fixed guess, not the real panel size; read the panel geometry
  // (portal / layer-shell) if a desktop ever exposes it to Electron.
  const height = Math.min(
    workArea.height,
    bounds.height - 2 * UNREPORTED_PANEL_ALLOWANCE,
    Math.floor(bounds.height * UNREPORTED_MAX_DISPLAY_FRACTION),
  );
  const nearBottom = near.y + near.height / 2 > bounds.y + bounds.height / 2;
  const y = nearBottom ? bounds.y + bounds.height - height : bounds.y;
  return { ...workArea, y, height };
}

/** The work-area half of the startup `[display]` line. */
export function linuxWorkAreaNote(display: LinuxDisplay): string {
  return workAreaReported(display)
    ? 'workArea reported'
    : 'workArea unreported → capped';
}

/**
 * Which edge of the display the taskbar/panel sits on, from the tray icon's
 * bounds: the work area is the screen minus the taskbar, so the offset between
 * workArea and display bounds reveals the taskbar side. Same idea as menubar's
 * internal taskbarLocation, but based on the display that actually contains
 * the icon (multi-monitor friendly).
 */
export function taskbarSideOf(display: {
  workArea: Rect;
  bounds: Rect;
}): TaskbarSide {
  const offX = display.workArea.x - display.bounds.x;
  const offY = display.workArea.y - display.bounds.y;
  if (offX > 0) return 'left';
  if (offY > 0) return 'top';
  if (display.workArea.width < display.bounds.width) return 'right';
  return 'bottom';
}

/**
 * Tray-relative electron-positioner position for each taskbar side: top bar →
 * the panel hangs from the bar, centered on the icon (exactly what macOS gets
 * with menubar's default 'trayCenter'); bottom bar → right above the bar,
 * centered; left/right bar → next to the bar edge.
 */
export function trayPositionForTaskbarSide(side: TaskbarSide): TrayPosition {
  switch (side) {
    case 'top':
      return 'trayCenter';
    case 'bottom':
      return 'trayBottomCenter';
    case 'left':
      return 'trayLeft';
    case 'right':
      return 'trayRight';
  }
}

/**
 * Keep the panel fully inside the work area (electron-positioner only guards
 * the right edge; a tray icon near the left edge would push the panel
 * off-screen otherwise).
 */
export function clampXToWorkArea(
  x: number,
  width: number,
  workArea: Rect,
): number {
  return Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
}

/**
 * Whether Electron reported real tray-icon bounds. Valid X11 bounds may sit at
 * x=0 (left panel), y=0 (top panel) or at negative coordinates (secondary
 * displays) — so only the dimensions distinguish real bounds from Wayland's
 * empty rectangle, not the position.
 */
export function hasTrayBounds(trayPos: Rect | undefined): trayPos is Rect {
  return Boolean(trayPos && trayPos.width > 0 && trayPos.height > 0);
}
