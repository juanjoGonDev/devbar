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
}

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
  let menuBar: MenubarLike | null = null;
  let lastTrayColor: TrayColor = 'stopped'; // so a theme flip can re-render
  // Errors/warnings badge drawn into the tray icon on win/linux. Remembered so
  // a theme flip re-renders it too.
  let lastTrayCount = 0;
  // Dev-only overrides, driven by the simulation panel. Both stay null in a
  // real run.
  let devTrayColor: TrayColor | null = null;
  let devTrayCount: number | null = null;

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
      tray.setImage(
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
