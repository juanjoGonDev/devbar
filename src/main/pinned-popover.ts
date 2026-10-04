import {
  TRAY_POPOVER_WIDTH,
  nextPinnedFrame,
  pinnedAutoHeightBounds,
  restorePinnedBounds,
  toPinnedPopover,
  type DisplayArea,
  type PinnedPopover,
} from './pinned-popover-geometry.js';
import type { Rect } from './window-geometry.js';

/**
 * The tray popover's PINNED mode: the first time the user drags it by its
 * header or resizes it, it stops hanging from the tray icon and reopens where
 * they left it, at the size they gave it, until they reset it.
 *
 * The hard part is telling the user's bounds changes from DevBar's own. The
 * popover is moved all the time without the user: menubar positions it on
 * every show, auto-height resizes it whenever the content changes, a reset
 * shrinks it back. Electron reports all of those through the same
 * move/resize events, so:
 *
 * - every change DevBar makes goes through {@linkcode PinnedPopoverController.programmatic}
 *   (menubar's own positioning is bracketed by its show/after-show events),
 *   which opens a short quiet window during which move/resize are ignored;
 * - where the OS says when a move or resize is manual (`will-move` /
 *   `will-resize`, macOS and Windows — never emitted for setBounds), only an
 *   announced change counts, quiet window or not;
 * - elsewhere (Linux), any change outside the quiet window is the user's.
 *
 * Every Electron effect is injected, so the whole state machine runs under
 * test with a fake window and a fake clock.
 */

/** How long DevBar's own setBounds may keep echoing move/resize events. */
const PROGRAMMATIC_SETTLE_MS = 300;
/** A will-move/will-resize covers the drag that follows it for this long. */
const USER_INTENT_MS = 1_000;
/** Auto-height leaves the window alone this long after a user change. */
const USER_INTERACTION_MS = 500;
/** Drags emit dozens of events; the store is written once they stop. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * The slice of `BrowserWindow` the controller needs. `on` is spelled as one
 * overload per event so the real, heavily overloaded `BrowserWindow` fits.
 */
export interface PopoverWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  getBounds(): Rect;
  setBounds(bounds: Rect, animate?: boolean): void;
  on(event: 'move', listener: () => void): unknown;
  on(event: 'resize', listener: () => void): unknown;
  on(event: 'will-move', listener: () => void): unknown;
  on(event: 'will-resize', listener: () => void): unknown;
}

export interface PinnedPopoverDeps {
  /** The popover, read late: menubar creates (and may recreate) it. */
  window: () => PopoverWindow | null;
  displays: () => readonly DisplayArea[];
  displayMatching: (rect: Rect) => DisplayArea;
  load: () => PinnedPopover | null;
  save: (value: PinnedPopover | null) => void;
  /** Tells the popover's renderer whether it is pinned (its reset button). */
  notify: (pinned: boolean) => void;
  /** Shows the visible popover again, anchored to the tray icon. */
  reanchor: () => void;
  /**
   * False on native Wayland, where the compositor ignores programmatic
   * positions: the user can still move the popover, but only its size is
   * restored.
   */
  restorePosition: boolean;
  /** Whether will-move / will-resize report manual changes (macOS, Windows). */
  intentEvents: boolean;
  /** The tray-anchored width a reset goes back to. */
  anchoredWidth: number;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface PinnedPopoverController {
  /** Subscribes to a (new) popover window's move/resize events. */
  attach: (win: PopoverWindow) => void;
  /** Runs one of DevBar's own bounds changes, which must not pin. */
  programmatic: (apply: () => void) => void;
  /** menubar's `show`: restores the pinned bounds before it positions. */
  beforeShow: () => void;
  /** menubar's `after-show`: its positioning is done. */
  afterShow: () => void;
  /** The spot menubar must use instead of the tray anchor, if any. */
  position: () => { x: number; y: number } | null;
  /**
   * The bounds for a new content height while pinned, or null when the
   * popover is tray-anchored (the anchored rule applies).
   */
  autoHeightBounds: (current: Rect, contentHeight: number) => Rect | null;
  isPinned: () => boolean;
  /** Forgets the pinned spot and puts the popover back by the tray icon. */
  reset: () => void;
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

export function createPinnedPopover(
  deps: PinnedPopoverDeps,
): PinnedPopoverController {
  let saved = deps.load();
  // The user's frame in screen coordinates: its height is the ceiling
  // auto-height grows to. Known once the popover was restored or pinned.
  let frame: Rect | null = null;
  let lastBounds: Rect | null = null;
  let lastContentHeight: number | null = null;
  let pendingPosition: { x: number; y: number } | null = null;
  let quietUntil = 0;
  let intentUntil = 0;
  let lastUserChangeAt = -Infinity;
  let saveTimer: unknown = null;

  function liveWindow(): PopoverWindow | null {
    const win = deps.window();
    return win && !win.isDestroyed() ? win : null;
  }

  function cancelSave(): void {
    if (saveTimer === null) return;
    deps.clearTimer(saveTimer);
    saveTimer = null;
  }

  function scheduleSave(): void {
    cancelSave();
    saveTimer = deps.setTimer(() => {
      saveTimer = null;
      deps.save(saved);
    }, SAVE_DEBOUNCE_MS);
  }

  function quiet(): void {
    quietUntil = deps.now() + PROGRAMMATIC_SETTLE_MS;
    intentUntil = 0;
  }

  function programmatic(apply: () => void): void {
    quiet();
    apply();
    const win = liveWindow();
    if (win) lastBounds = win.getBounds();
  }

  function isUserChange(now: number): boolean {
    if (now < intentUntil) return true;
    return !deps.intentEvents && now >= quietUntil;
  }

  function onBoundsChanged(): void {
    const win = liveWindow();
    if (!win) return;
    const current = win.getBounds();
    const previous = lastBounds ?? current;
    lastBounds = current;
    if (!win.isVisible()) return;
    const now = deps.now();
    if (!isUserChange(now)) return;
    // The OS announced the drag once; the rest of it keeps counting.
    if (deps.intentEvents) intentUntil = now + USER_INTENT_MS;
    lastUserChangeAt = now;
    if (sameRect(previous, current)) return;
    const wasPinned = saved !== null;
    frame = nextPinnedFrame(frame, previous, current);
    saved = toPinnedPopover(frame, deps.displayMatching(frame));
    scheduleSave();
    if (!wasPinned) deps.notify(true);
  }

  function onUserIntent(): void {
    intentUntil = deps.now() + USER_INTENT_MS;
  }

  /** Back to tray-anchored: no spot, no frame, the anchored width. */
  function unpin(): void {
    cancelSave();
    saved = null;
    frame = null;
    pendingPosition = null;
    deps.save(null);
    deps.notify(false);
    const win = liveWindow();
    if (win)
      programmatic(() =>
        win.setBounds({ ...win.getBounds(), width: deps.anchoredWidth }),
      );
  }

  return {
    attach(win): void {
      lastBounds = win.getBounds();
      win.on('will-move', onUserIntent);
      win.on('will-resize', onUserIntent);
      win.on('move', onBoundsChanged);
      win.on('resize', onBoundsChanged);
    },
    programmatic,

    beforeShow(): void {
      quiet();
      pendingPosition = null;
      if (!saved) return;
      const restored = restorePinnedBounds(saved, deps.displays());
      const display = deps.displays().find((d) => d.id === saved?.displayId);
      if (!restored || !display) {
        unpin();
        return;
      }
      frame = restored;
      const target = pinnedAutoHeightBounds(
        restored,
        lastContentHeight ?? restored.height,
        display.workArea,
      );
      const win = liveWindow();
      if (!win) return;
      if (deps.restorePosition) {
        programmatic(() => win.setBounds(target));
        pendingPosition = { x: target.x, y: target.y };
      } else {
        programmatic(() =>
          win.setBounds({
            ...win.getBounds(),
            width: target.width,
            height: target.height,
          }),
        );
      }
    },

    afterShow(): void {
      quiet();
      pendingPosition = null;
      const win = liveWindow();
      if (win) lastBounds = win.getBounds();
    },

    position: () => pendingPosition,

    autoHeightBounds(current, contentHeight): Rect | null {
      lastContentHeight = contentHeight;
      if (!saved || !frame) return null;
      // Resizing under a pointer that is still dragging fights the user.
      if (deps.now() - lastUserChangeAt < USER_INTERACTION_MS) return current;
      const next = pinnedAutoHeightBounds(
        frame,
        contentHeight,
        deps.displayMatching(frame).workArea,
      );
      return deps.restorePosition
        ? next
        : { ...current, width: next.width, height: next.height };
    },

    isPinned: () => saved !== null,

    reset(): void {
      unpin();
      if (liveWindow()?.isVisible()) deps.reanchor();
    },
  };
}

type PositionerCalculate = (
  position: string,
  trayBounds?: Rect,
) => { x: number; y: number };

/**
 * menubar positions the popover on every show through its positioner, then
 * calls setPosition with the result. Answering with the pinned spot there —
 * rather than moving the window after `after-show` — means a pinned popover
 * never flashes under the tray icon first.
 */
export function patchPinnedPositioning(
  positioner: { calculate: PositionerCalculate },
  pinned: () => { x: number; y: number } | null,
): void {
  const original = positioner.calculate.bind(positioner);
  positioner.calculate = (position, trayBounds) =>
    pinned() ?? original(position, trayBounds);
}

/** The slice of menubar the Electron wiring needs. */
interface MenubarLike {
  window:
    | (PopoverWindow & {
        webContents: { send: (channel: string, ...args: unknown[]) => void };
      })
    | undefined;
  hideWindow: () => void;
  showWindow: () => Promise<void>;
}

/**
 * The controller wired to the real app: menubar's popover, the screen, the
 * config store and the platform's quirks (native Wayland restores the size
 * only; macOS and Windows announce manual moves).
 */
export function createMenubarPinnedPopover(input: {
  menubar: () => MenubarLike | null;
  host: {
    displays: () => readonly DisplayArea[];
    displayMatching: (rect: Rect) => DisplayArea;
    nativeWayland: boolean;
  };
  store: {
    getTrayPopover: () => PinnedPopover | null;
    saveTrayPopover: (value: PinnedPopover | null) => void;
  };
  platform: NodeJS.Platform;
  now?: () => number;
}): PinnedPopoverController {
  return createPinnedPopover({
    window: () => input.menubar()?.window ?? null,
    displays: input.host.displays,
    displayMatching: input.host.displayMatching,
    load: input.store.getTrayPopover,
    save: input.store.saveTrayPopover,
    notify: (pinned) => {
      const win = input.menubar()?.window;
      if (win && !win.isDestroyed())
        win.webContents.send('tray:pinned', pinned);
    },
    reanchor: () => {
      const bar = input.menubar();
      if (!bar) return;
      // Hide + show re-runs menubar's own tray-anchored positioning.
      bar.hideWindow();
      void bar.showWindow();
    },
    restorePosition: !input.host.nativeWayland,
    intentEvents: input.platform === 'darwin' || input.platform === 'win32',
    anchoredWidth: TRAY_POPOVER_WIDTH,
    now: input.now ?? (() => Date.now()),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}
