import type { NativeImage } from 'electron';
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
 */

interface TrayLike {
  setImage: (image: NativeImage) => void;
  setTitle: (title: string) => void;
  setToolTip: (tooltip: string) => void;
}

interface MenubarLike {
  tray: TrayLike | null | undefined;
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
   *  INSTEAD of replacing — a burst of updates stacks the states visually
   *  — so pushes there are deduplicated and coalesced. */
  platform?: string;
  /** Millisecond clock for the coalescing window. */
  now?: () => number;
  /** Schedules the deferred flush of a coalesced push. */
  schedule?: (fn: () => void, ms: number) => void;
}

/** Minimum spacing between actual Linux tray pixmap pushes; shorter than
 *  any human-perceivable delay, long enough to collapse a burst of
 *  state updates (start/stop churn, error-count ticks) into one push. */
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
  let lastTrayColor: TrayColor = 'stopped'; // so a theme flip can re-render
  // Errors/warnings badge drawn into the tray icon on win/linux. Remembered so
  // a theme flip re-renders it too.
  let lastTrayCount = 0;
  // Dev-only overrides, driven by the simulation panel. Both stay null in a
  // real run.
  let devTrayColor: TrayColor | null = null;
  let devTrayCount: number | null = null;
  // Linux push coalescing: the last image actually pushed, the clock at
  // that push, the image waiting for the window to elapse, and whether a
  // flush is already scheduled.
  let lastPushedImage: NativeImage | null = null;
  let lastPushAt = -Infinity;
  let pendingImage: NativeImage | null = null;
  let flushScheduled = false;

  function pushNow(image: NativeImage): void {
    const tray = menuBar?.tray;
    if (!tray) return;
    try {
      tray.setImage(image);
      lastPushedImage = image;
      lastPushAt = now();
    } catch (err) {
      console.error('setImage failed:', err);
    }
  }

  function pushCoalesced(image: NativeImage): void {
    // loadIcon() caches by rendered key, so the SAME NativeImage instance
    // means the SAME pixels: pushing it again is pure panel churn (and on
    // Linux applets, exactly the paint-over-instead-of-replace bug).
    if (image === lastPushedImage) return;
    if (!linux) {
      pushNow(image);
      return;
    }
    const elapsed = now() - lastPushAt;
    if (flushScheduled) {
      pendingImage = image;
      return;
    }
    if (elapsed >= TRAY_PUSH_MIN_INTERVAL_MS) {
      pushNow(image);
      return;
    }
    // Inside the window: hold the image and flush once, later — the LAST
    // state of the burst is the only one the panel needs to see.
    pendingImage = image;
    flushScheduled = true;
    schedule(() => {
      flushScheduled = false;
      const queued = pendingImage;
      pendingImage = null;
      if (queued && queued !== lastPushedImage) pushNow(queued);
    }, TRAY_PUSH_MIN_INTERVAL_MS - elapsed);
  }

  /**
   * Repaint the menubar mark for the current state. The mark carries a small
   * red badge while an update is pending — the same "there is something new"
   * cue the version chips show in the popover and in config.
   */
  function refreshIcon(): void {
    const tray = menuBar?.tray;
    if (!tray) return;
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
    },
    refreshIcon,
    simulatedCount: () => devTrayCount,

    updateTitle(payload): void {
      const tray = menuBar?.tray;
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
      tray.setToolTip(trayTooltip(shown, devTrayCount != null || errs > 0));
      refreshIcon();
    },

    setSimulatedColor(color): void {
      devTrayColor = color;
      refreshIcon();
    },

    setSimulatedCount(count): void {
      devTrayCount = count;
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
