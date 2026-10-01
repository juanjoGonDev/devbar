import type { Menubar } from 'menubar';
import {
  createMenubarPinnedPopover,
  type PinnedPopoverController,
} from './pinned-popover.js';
import { trayIconBounds } from './tray.js';
import type { WindowIpcDeps } from './ipc/window-ipc.js';

type PinnedInput = Parameters<typeof createMenubarPinnedPopover>[0];

/**
 * What the IPC handlers may do to the tray popover: hide it, size it, and
 * drive its pinned mode. menubar is read late (it only exists once Electron
 * is ready), so every member goes through `menubar()`.
 */
export function createTrayHost(
  menubar: () => Menubar | null,
  host: PinnedInput['host'] & {
    workAreaFor: WindowIpcDeps['trayHost']['workAreaFor'];
    platform: NodeJS.Platform;
  },
  store: PinnedInput['store'],
): WindowIpcDeps['trayHost'] & { pinned: PinnedPopoverController } {
  return {
    hideIfVisible: () => {
      const bar = menubar();
      if (bar?.window?.isVisible()) bar.hideWindow();
    },
    hide: () => menubar()?.hideWindow(),
    popover: () => menubar()?.window ?? null,
    workAreaFor: host.workAreaFor,
    trayIconBounds: () => trayIconBounds(menubar()),
    // Dragged or resized by the user, the popover reopens there instead of
    // under the tray icon (see src/main/pinned-popover.ts).
    pinned: createMenubarPinnedPopover({
      menubar,
      host,
      store,
      platform: host.platform,
    }),
  };
}
