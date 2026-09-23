import { describe, expect, it, vi } from 'vitest';

// tray.ts reaches tray-icon.ts for the badge and colour aggregation, which
// imports electron for nativeImage/nativeTheme.
vi.mock('electron', () => ({
  nativeImage: {
    createFromBitmap: () => ({
      addRepresentation: () => undefined,
      setTemplateImage: () => undefined,
    }),
  },
  nativeTheme: { shouldUseDarkColors: false },
}));

import type { NativeImage, Tray as ElectronTray } from 'electron';
import {
  createTrayController,
  linuxRebuildPieces,
  shouldRebuildTrayItems,
  TRAY_PUSH_MIN_INTERVAL_MS,
} from '../src/main/tray.js';

/**
 * Every tray item the controller builds is counted here, because a ghost
 * icon on a full desktop shell IS one of these constructions: the panel's
 * tray host keeps the old item registered and the new one appears beside
 * it. Zero constructions is the only thing that proves the leak is gone.
 */
class CountingTray {
  static built = 0;
  constructor() {
    CountingTray.built += 1;
  }
  setImage(): void {}
  setTitle(): void {}
  setToolTip(): void {}
  destroy(): void {}
  on(): void {}
  popUpContextMenu(): void {}
}

interface GateRun {
  /** Tray items constructed — the ghost icons, one per rebuild. */
  built: number;
  /** In-place pixmap pushes into the item menubar already created. */
  pushes: number;
}

/**
 * Wires the gate the way main.ts does — its result spread into the
 * controller's deps — and drives `changes` separate state changes through
 * it. Nothing here decides whether a rebuild happens: that is the gate's
 * answer for `desktop`, which is the point of the test.
 */
function runOn(desktop: string, changes: number): GateRun {
  CountingTray.built = 0;
  let clock = 0;
  let nth = 0;
  const pushes: NativeImage[] = [];
  const deferred: (() => void)[] = [];
  const controller = createTrayController({
    // A different instance every time, and no getSize/toBitmap on it: the
    // surface check cannot read the pixels, plays safe and asks for a
    // rebuild. So every change after the first reaches the branch the gate
    // guards, instead of being waved through as a safe in-place push.
    loadIcon: () => ({ n: nth++ }) as unknown as NativeImage,
    isMac: false,
    hasUpdate: () => false,
    // Stands in for a Linux host's own process.platform. The gate
    // contributes no platform when it declines to rebuild, and without this
    // the fallback would be whatever machine runs the suite.
    platform: 'linux',
    now: () => clock,
    schedule: (fn) => {
      deferred.push(fn);
    },
    ...linuxRebuildPieces(
      CountingTray as unknown as typeof ElectronTray,
      () => ({ menu: true }),
      'linux',
      desktop,
    ),
  });
  const bar = {
    tray: {
      setImage: (image: NativeImage) => pushes.push(image),
      setTitle: () => undefined,
      setToolTip: () => undefined,
    },
    clicked: () => undefined,
  };
  controller.attach(bar);
  for (let i = 0; i < changes; i += 1) {
    // Past the coalescing window each time, so the changes stay separate
    // paints instead of collapsing into one.
    clock += TRAY_PUSH_MIN_INTERVAL_MS;
    controller.updateTitle([]);
  }
  for (const flush of deferred.splice(0)) flush();
  return { built: CountingTray.built, pushes: pushes.length };
}

describe('src/main/tray.ts rebuild gate', () => {
  describe('shouldRebuildTrayItems', () => {
    it('rebuilds on the bare panels that need a fresh surface', () => {
      expect(shouldRebuildTrayItems('linux', 'labwc:wlroots')).toBe(true);
      expect(shouldRebuildTrayItems('linux', 'wayfire')).toBe(true);
      expect(shouldRebuildTrayItems('linux', 'LXDE')).toBe(true);
      expect(shouldRebuildTrayItems('linux', 'LXQt')).toBe(true);
    });

    it('pushes in place on full desktop shells: they leak recreated items', () => {
      // GNOME and Plasma are the two reported leaks. Everything after them
      // is a shell the denylist this replaced never mentioned, so each one
      // used to take the rebuild path.
      for (const desktop of [
        'ubuntu:GNOME',
        'GNOME',
        'pop:GNOME',
        'Pantheon',
        'KDE',
        'plasma',
        'X-Cinnamon',
        'MATE',
        'XFCE',
        'Deepin',
        'COSMIC',
        'Budgie:GNOME',
      ]) {
        expect(shouldRebuildTrayItems('linux', desktop), desktop).toBe(false);
      }
    });

    it('pushes in place when the desktop is unknown or unset', () => {
      // The safe-by-default case, and the whole reason the list points this
      // way round. An unset XDG_CURRENT_DESKTOP is ordinary — `sudo -i`, a
      // systemd user unit without `import-environment`, GitHub's
      // ubuntu-latest — and under the denylist it matched nothing and took
      // the rebuild. Guessing wrong here costs one smear that the next
      // state change repaints; guessing wrong the other way costs a ghost
      // icon per change until the session is restarted.
      expect(shouldRebuildTrayItems('linux', '')).toBe(false);
      expect(shouldRebuildTrayItems('linux', 'shell-nobody-listed')).toBe(
        false,
      );
    });

    it('matches whole tokens, not substrings', () => {
      // XDG_CURRENT_DESKTOP is colon-separated, so the comparison is per
      // token. A substring test over the raw string would rebuild for both
      // of these — the same bug class that once found `arc` inside
      // "search".
      expect(shouldRebuildTrayItems('linux', 'labwc-compatible-shell')).toBe(
        false,
      );
      expect(shouldRebuildTrayItems('linux', 'ubuntu:not-lxqt-really')).toBe(
        false,
      );
    });

    it('never rebuilds off Linux', () => {
      // Both desktops are ALLOWED ones, so only the platform guard can
      // answer false here: with an unlisted desktop the allowlist would say
      // false anyway and deleting the guard would go unnoticed.
      expect(shouldRebuildTrayItems('darwin', 'labwc:wlroots')).toBe(false);
      expect(shouldRebuildTrayItems('win32', 'LXDE')).toBe(false);
    });
  });

  describe('linuxRebuildPieces', () => {
    // The platform is a parameter, not `process.platform`: the assertion has
    // to mean the same thing on the macOS and Windows runners.
    const fakeTray = class {} as unknown as typeof ElectronTray;
    const pieces = (platform: NodeJS.Platform, desktop: string) =>
      linuxRebuildPieces(fakeTray, () => ({}), platform, desktop);

    it('contributes pieces on a compositor-less panel', () => {
      expect(Object.keys(pieces('linux', 'labwc:wlroots'))).toEqual([
        'platform',
        'rebuildPieces',
      ]);
    });

    it('contributes nothing on a desktop that leaks recreated items', () => {
      expect(pieces('linux', 'ubuntu:GNOME')).toEqual({});
      expect(pieces('linux', 'KDE')).toEqual({});
      expect(pieces('linux', 'X-Cinnamon')).toEqual({});
    });

    it('contributes nothing when the desktop never announced itself', () => {
      expect(pieces('linux', '')).toEqual({});
    });

    it('contributes nothing off Linux', () => {
      expect(pieces('darwin', 'labwc:wlroots')).toEqual({});
    });
  });

  describe('the controller, wired through the gate', () => {
    it('builds no tray item at all on a GNOME desktop', () => {
      const run = runOn('ubuntu:GNOME', 5);
      expect(run.built, 'tray items constructed').toBe(0);
      expect(run.pushes, 'in-place pushes').toBe(5);
    });

    it('builds no tray item at all on KDE Plasma', () => {
      const run = runOn('KDE', 5);
      expect(run.built, 'tray items constructed').toBe(0);
      expect(run.pushes, 'in-place pushes').toBe(5);
    });

    it('builds no tray item at all when the desktop is unset', () => {
      const run = runOn('', 5);
      expect(run.built, 'tray items constructed').toBe(0);
      expect(run.pushes, 'in-place pushes').toBe(5);
    });

    it("rebuilds the item on the Pi's panel, which needs it", () => {
      const run = runOn('labwc:wlroots', 5);
      // The first paint reuses the item menubar already created; each of
      // the four later changes swaps in a fresh one.
      expect(run.built, 'tray items constructed').toBe(4);
      expect(run.pushes, 'in-place pushes').toBe(1);
    });
  });
});
