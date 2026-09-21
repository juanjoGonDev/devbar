import type { NativeImage, Tray as ElectronTray } from 'electron';
import { aggregateColor, badgeCount } from '../tray-icon.js';
import {
  clampXToWorkArea,
  hasTrayBounds,
  taskbarSideOf,
  trayPositionForTaskbarSide,
  type Rect,
} from './window-geometry.js';
import { countAlerts, trayTitleText, trayTooltip } from './tray-view.js';
import type { GroupState, TrayColor } from '../ipc-contract.js';

/**
 * The menubar mark: repainting it for the current state, and carrying the
 * alert count as macOS title text or as a badge drawn into the icon on
 * win/linux (where tray titles are not rendered at all).
 *
 * The dev-panel overrides live here too. They win over the real aggregate for
 * what is PAINTED, but the real values are still remembered, so releasing an
 * override repaints the true state instead of freezing the forced one.
 *
 * On Linux, pushes that could leave the old icon visible REBUILD the whole
 * tray item instead: compositor-less X11 and some applets (Raspberry Pi OS
 * among them) draw each new pixmap OVER the previous buffer instead of
 * replacing it, so the transparent pixels of the new icon showed every old
 * state behind it. A fresh item starts with a fresh surface — the only fix
 * that does not depend on the applet's painting semantics. Two refinements
 * keep that invisible in practice: only alpha-shrinking transitions rebuild
 * (everything else is a flicker-free in-place push), and the fresh item is
 * registered BEFORE the stale one is destroyed, so the applet never spends
 * a frame without an icon.
 */

interface TrayLike {
  setImage: (image: NativeImage) => void;
  setTitle: (title: string) => void;
  setToolTip: (tooltip: string) => void;
}

/**
 * Electron's {@linkcode Tray} constructor, narrowed to what a rebuild needs:
 * construction from an image and the {@linkcode RebuildableTray} surface.
 * (The real Tray type carries Electron's whole event-overload set, which
 * structurally exceeds this shape — hence the narrowing cast.)
 */
type TrayConstructor = new (
  image: string | Parameters<TrayLike['setImage']>[0],
  guid?: string,
) => RebuildableTray;

/** What a rebuild needs from a real Electron Tray. */
export interface RebuildableTray extends TrayLike {
  destroy: () => void;
  on: (
    event: 'click' | 'double-click' | 'right-click',
    listener: () => void,
  ) => unknown;
  popUpContextMenu: (menu: unknown) => void;
}

interface MenubarLike {
  tray: TrayLike;
}

export interface TrayControllerDeps {
  loadIcon: (
    state: TrayColor,
    hasUpdate: boolean,
    count: number,
  ) => NativeImage;
  isMac: boolean;
  /** Whether a newer release is known, which adds the small red badge. */
  hasUpdate: () => boolean;
  /** The host platform. Linux tray applets repaint on every pixmap push
   *  INSTEAD of replacing — pushes there are deduplicated, coalesced and,
   *  when the pieces are provided, turned into full item rebuilds. */
  platform?: string;
  /** Millisecond clock for the coalescing window. */
  now?: () => number;
  /** Schedules the deferred flush of a coalesced push. */
  schedule?: (fn: () => void, ms: number) => void;
  /**
   * Linux only: the Electron Tray constructor and the tray context-menu
   * builder, so a visual change can rebuild the whole item. Without these
   * (other platforms, tests) changes push pixmaps into the existing item.
   */
  rebuildPieces?: {
    Tray: new (image: NativeImage) => RebuildableTray;
    buildContextMenu: () => unknown;
  };
}

/**
 * Whether a plain pixmap push would leave the previous icon visible behind.
 * Compositor-less applets paint each new pixmap OVER the old buffer, so any
 * pixel that was opaque and turns transparent lets the old content bleed
 * through — only those transitions need a fresh item surface. Grow-or-stay
 * transitions are safe to push in place. Unreadable or resized images play
 * safe and reset the surface.
 */
function needsSurfaceReset(prev: NativeImage, next: NativeImage): boolean {
  try {
    const a = prev.getSize();
    const b = next.getSize();
    if (a.width !== b.width || a.height !== b.height) return true;
    const old = prev.toBitmap();
    const fresh = next.toBitmap();
    const bytes = a.width * a.height * 4;
    if (old.length < bytes || fresh.length < bytes) return true;
    for (let i = 3; i < bytes; i += 4) {
      if ((old[i] ?? 0) > 0 && (fresh[i] ?? 255) < 255) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether tray-item rebuilds are wired at all. The rebuild exists for
 * panels that composite pixmaps without clearing (the Raspberry Pi's);
 * GNOME-family appindicator hosts instead LEAK a tray item per recreate
 * (each rebuild left one more ghost icon on Ubuntu), and those panels
 * replace the pixmap correctly — so there the icon is pushed in place.
 */
export function shouldRebuildTrayItems(
  platform: string,
  desktop: string,
): boolean {
  if (platform !== 'linux') return false;
  return !/gnome|unity|pantheon/i.test(desktop);
}

/** Minimum spacing between actual Linux tray repaints; shorter than any
 *  human-perceivable delay, long enough to collapse a burst of state
 *  updates (start/stop churn, error-count ticks) into one item rebuild. */
export const TRAY_PUSH_MIN_INTERVAL_MS = 250;

export interface TrayController {
  attach: (menuBar: MenubarLike) => void;
  refreshIcon: () => void;
  updateTitle: (payload: readonly GroupState[]) => void;
  setSimulatedColor: (color: TrayColor | null) => void;
  setSimulatedCount: (count: number | null) => void;
  /** The count the dev panel forced, if any — macOS applies it immediately. */
  simulatedCount: () => number | null;
}

export function createTrayController(deps: TrayControllerDeps): TrayController {
  const linux = (deps.platform ?? process.platform) === 'linux';
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  let menuBar: MenubarLike | null = null;
  // The tray the controller last knows about. Resolved from menubar on
  // first use, then owned by the controller (a rebuild swaps both menubar's
  // field and this).
  let currentTray: TrayLike | null = null;
  let lastTrayColor: TrayColor = 'stopped'; // so a theme flip can re-render
  // Errors/warnings badge drawn into the tray icon on win/linux. Remembered so
  // a theme flip re-renders it too.
  let lastTrayCount = 0;
  // Dev-only overrides, driven by the simulation panel. Both stay null in a
  // real run.
  let devTrayColor: TrayColor | null = null;
  let devTrayCount: number | null = null;
  // Linux repaint bookkeeping: the last image actually applied, the clock at
  // that moment, the image waiting for the coalescing window to elapse, and
  // whether a flush is already scheduled.
  let lastPushedImage: NativeImage | null = null;
  let lastPushAt = -Infinity;
  let pendingImage: NativeImage | null = null;
  let flushScheduled = false;
  // Reapplied to every rebuilt tray: a fresh item would otherwise come up
  // with menubar's creation-time tooltip.
  let lastTooltip = 'DevBar';

  function activeTray(): TrayLike | null {
    if (currentTray) return currentTray;
    try {
      return menuBar?.tray ?? null;
    } catch {
      // menubar's getter throws before the tray exists; nothing to paint on.
      return null;
    }
  }

  function pushNow(image: NativeImage): void {
    const tray = activeTray();
    if (!tray) return;
    try {
      tray.setImage(image);
      currentTray = tray;
      lastPushedImage = image;
      lastPushAt = now();
    } catch (err) {
      console.error('setImage failed:', err);
    }
  }

  function rebuildNow(image: NativeImage): void {
    const pieces = deps.rebuildPieces;
    const bar = menuBar;
    if (!pieces || !bar) {
      pushNow(image);
      return;
    }
    // The old item is destroyed LAST, after the fresh one is already wired
    // in: destroying first left the applet with no icon for the whole
    // re-registration round trip, which read as a vanish-and-reappear
    // flicker. Registering first means the panel swaps items within a
    // frame — never a blank moment.
    let fresh: RebuildableTray;
    try {
      fresh = new pieces.Tray(image);
    } catch (err) {
      console.error('tray rebuild failed:', err);
      // The old item is untouched and still on screen: a plain push at
      // least shows the new state.
      pushNow(image);
      return;
    }
    // menubar bound click/double-click → its own `clicked` at creation;
    // rebind the same handlers, plus the context menu this app adds.
    // menubar's own fields, reached deliberately: it bound its internal
    // `_tray` and its click handlers at creation, and a rebuilt item must
    // take over both or menubar would click/position against a dead tray.
    const inner = bar as {
      clicked?: () => void;
      _tray?: TrayLike;
    };
    try {
      const clicked = inner.clicked?.bind(bar);
      if (clicked) {
        fresh.on('click', clicked);
        fresh.on('double-click', clicked);
      }
      fresh.on('right-click', () =>
        fresh.popUpContextMenu(pieces.buildContextMenu()),
      );
      fresh.setToolTip(lastTooltip);
    } catch (err) {
      // The item exists and shows the right icon; degraded wiring beats
      // dropping it.
      console.error('tray rebuild wiring failed:', err);
    }
    const stale = currentTray;
    inner._tray = fresh;
    currentTray = fresh;
    lastPushedImage = image;
    lastPushAt = now();
    try {
      if (stale && typeof (stale as RebuildableTray).destroy === 'function')
        (stale as RebuildableTray).destroy();
    } catch (err) {
      console.error('tray item destroy failed:', err);
    }
  }

  function applyToPanel(image: NativeImage): void {
    // A surface reset (fresh item) is only needed when the previous icon
    // could bleed through the new one — a transparent pixel sitting where
    // the old image was opaque. Every other change is a plain in-place
    // setImage: no flicker, no applet churn. The very first paint always
    // goes through setImage too, reusing menubar's own creation-time item.
    if (
      linux &&
      deps.rebuildPieces &&
      lastPushedImage !== null &&
      needsSurfaceReset(lastPushedImage, image)
    ) {
      rebuildNow(image);
      return;
    }
    pushNow(image);
  }

  function pushCoalesced(image: NativeImage): void {
    // loadIcon() caches by rendered key, so the SAME NativeImage instance
    // means the SAME pixels: pushing it again is pure panel churn — and on
    // the Pi, another layer of paint-over.
    if (image === lastPushedImage) {
      // A→B→A inside the coalescing window: B is stale the moment the
      // final A re-arrives equal to what is on screen — applying it later
      // would resurface an intermediate state.
      pendingImage = null;
      return;
    }
    if (!linux) {
      applyToPanel(image);
      return;
    }
    const elapsed = now() - lastPushAt;
    if (flushScheduled) {
      pendingImage = image;
      return;
    }
    if (elapsed >= TRAY_PUSH_MIN_INTERVAL_MS) {
      applyToPanel(image);
      return;
    }
    // Inside the window: hold the image and apply once, later — the LAST
    // state of the burst is the only one the panel needs to see.
    pendingImage = image;
    flushScheduled = true;
    schedule(() => {
      flushScheduled = false;
      const queued = pendingImage;
      pendingImage = null;
      if (queued && queued !== lastPushedImage) applyToPanel(queued);
    }, TRAY_PUSH_MIN_INTERVAL_MS - elapsed);
  }

  /**
   * Repaint the menubar mark for the current state. The mark carries a small
   * red badge while an update is pending — the same "there is something new"
   * cue the version chips show in the popover and in config.
   */
  function refreshIcon(): void {
    if (!menuBar) return;
    try {
      // macOS carries the count as tray title text; win/linux don't render
      // titles, so the count is drawn into the icon itself.
      pushCoalesced(
        deps.loadIcon(
          devTrayColor ?? lastTrayColor,
          deps.hasUpdate(),
          deps.isMac ? 0 : (devTrayCount ?? lastTrayCount),
        ),
      );
    } catch (err) {
      console.error('setImage failed:', err);
    }
  }

  return {
    attach(next): void {
      menuBar = next;
      currentTray = null;
    },
    refreshIcon,
    simulatedCount: () => devTrayCount,

    updateTitle(payload): void {
      if (!menuBar) return;
      const tray = activeTray();
      if (!tray) return;
      lastTrayColor = aggregateColor(payload);
      const { warns, errs } = countAlerts(payload);
      const count = badgeCount(errs, warns);
      const shown = devTrayCount ?? count;
      if (deps.isMac) {
        tray.setTitle(trayTitleText(shown));
      } else {
        lastTrayCount = count;
      }
      // The dev-panel override keeps "error" — that is what the panel forces.
      lastTooltip = trayTooltip(shown, devTrayCount != null || errs > 0);
      tray.setToolTip(lastTooltip);
      refreshIcon();
    },

    setSimulatedColor(color): void {
      devTrayColor = color;
      refreshIcon();
    },

    setSimulatedCount(count): void {
      devTrayCount = count;
      // Releasing (or forcing) a count repaints NOW: the panel button must
      // not wait for the next unrelated state broadcast.
      refreshIcon();
    },
  };
}

type PositionerCalculate = (
  position: string,
  trayBounds?: Rect,
) => { x: number; y: number };

/**
 * menubar v9 deliberately does NOT place the Linux panel next to the tray icon:
 * it overwrites the position with a screen-corner fallback (its own
 * taskbarLocation), so the panel opens in a corner — or wherever the compositor
 * decides — instead of right where the icon is, like macOS.
 *
 * When Electron reports the icon's real bounds (X11), redirect the calculation
 * to a tray-relative position. On Wayland the bounds are (0,0) and the
 * compositor owns window placement, so menubar's behavior is kept there.
 */
export function patchLinuxTrayPositioning(input: {
  positioner: { calculate: PositionerCalculate };
  /** Current popover width, or null when there is no window yet. */
  windowWidth(): number | null;
  displayMatching(rect: Rect): { workArea: Rect; bounds: Rect };
  sessionType: string;
}): void {
  const { positioner } = input;
  const originalCalculate = positioner.calculate.bind(positioner);
  let logged = false;
  positioner.calculate = (position, trayPos) => {
    if (hasTrayBounds(trayPos)) {
      const width = input.windowWidth();
      if (width === null) return originalCalculate(position, trayPos);
      const display = input.displayMatching(trayPos);
      const result = originalCalculate(
        trayPositionForTaskbarSide(taskbarSideOf(display)),
        trayPos,
      );
      if (!logged) {
        logged = true;
        console.log(
          `[tray] icono en (${trayPos.x},${trayPos.y} ${trayPos.width}x${trayPos.height}, ` +
            `sesión ${input.sessionType}) → panel junto al icono`,
        );
      }
      return {
        x: clampXToWorkArea(result.x, width, display.workArea),
        y: result.y,
      };
    }
    if (!logged) {
      logged = true;
      console.log(
        `[tray] sin bounds del icono (sesión ${input.sessionType}) → ` +
          'posición por defecto de menubar',
      );
    }
    return originalCalculate(position, trayPos);
  };
}

/**
 * Linux-only wiring for tray-item rebuilds: hands the controller the real
 * {@linkcode Tray} constructor plus the context-menu factory so a corrupted
 * item can be replaced wholesale (see rebuildNow). On other platforms the
 * spread contributes nothing and pushes stay plain setImage calls.
 */
export function linuxRebuildPieces(
  Tray: typeof ElectronTray,
  buildContextMenu: () => unknown,
  desktop: string,
): Partial<Pick<TrayControllerDeps, 'platform' | 'rebuildPieces'>> {
  // GNOME-family panels leak a tray item per recreate (Ubuntu): there the
  // pieces contribute nothing and pushes stay in place.
  if (!shouldRebuildTrayItems(process.platform, desktop)) return {};
  return {
    platform: process.platform,
    rebuildPieces: {
      Tray: Tray as unknown as TrayConstructor,
      buildContextMenu,
    },
  };
}
