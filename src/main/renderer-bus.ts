/**
 * The set of live windows, and the fan-out over them. Every push from the main
 * process (`groups:update`, toasts, theme changes) goes through here, so
 * "which windows hear this" is decided in exactly one place instead of once
 * per call site.
 *
 * Windows are held structurally rather than as `BrowserWindow`, which is what
 * lets the fan-out rules be exercised without Electron.
 */

export interface WebContentsLike {
  send: (channel: string, ...args: unknown[]) => void;
}

export interface WindowLike {
  isDestroyed: () => boolean;
  webContents: WebContentsLike;
  setBackgroundColor: (color: string) => void;
  getTitle: () => string;
  show: () => void;
  focus: () => void;
}

/**
 * The subset of `BrowserWindow` the window builders touch. Declared as the
 * real Electron type so production stays exactly typed; tests hand in a fake
 * and cast it, which keeps the builders' wiring checkable without Electron.
 */
export interface WindowRegistry {
  /** The menubar popover — read late, since menubar creates it itself. */
  trayPopover: () => WindowLike | null;
  config: WindowLike | null;
  /** '@main' is the shared multi-log window; any other key is a detached one. */
  readonly logs: Map<string, WindowLike>;
  readonly silenced: Map<string, WindowLike>;
  readonly prescriptConfirm: Map<string, WindowLike>;
}

/** Key of the shared multi-log window (sidebar + one visible log). */
export const MAIN_LOGS_KEY = '@main';

export function createWindowRegistry(
  trayPopover: () => WindowLike | null,
): WindowRegistry {
  return {
    trayPopover,
    config: null,
    logs: new Map(),
    silenced: new Map(),
    prescriptConfirm: new Map(),
  };
}

function alive(win: WindowLike | null | undefined): win is WindowLike {
  return Boolean(win && !win.isDestroyed());
}

/**
 * Every renderer that consumes the group-state / pipeline / toast / update
 * stream. The pre-script confirm modal is deliberately NOT here: it would
 * receive a whole stream it has no use for.
 */
export function rendererTargets(registry: WindowRegistry): WebContentsLike[] {
  const targets: WebContentsLike[] = [];
  const popover = registry.trayPopover();
  if (alive(popover)) targets.push(popover.webContents);
  if (alive(registry.config)) targets.push(registry.config.webContents);
  for (const win of registry.logs.values())
    if (alive(win)) targets.push(win.webContents);
  for (const win of registry.silenced.values())
    if (alive(win)) targets.push(win.webContents);
  return targets;
}

/**
 * Theme fan-out targets: every renderer, plus the pre-script confirm modal.
 * That modal stays out of `rendererTargets` but does paint themed chrome, so
 * it must hear a theme change.
 */
export function themeTargets(registry: WindowRegistry): WebContentsLike[] {
  const targets = rendererTargets(registry);
  for (const win of registry.prescriptConfirm.values())
    if (alive(win)) targets.push(win.webContents);
  return targets;
}

export function sendToRenderers(
  registry: WindowRegistry,
  channel: string,
  payload: unknown,
): void {
  for (const wc of rendererTargets(registry)) wc.send(channel, payload);
}

/** Whether any real app window (not the tray popover) is on screen. */
export function anyAppWindowOpen(registry: WindowRegistry): boolean {
  return (
    registry.logs.size > 0 ||
    registry.silenced.size > 0 ||
    registry.prescriptConfirm.size > 0 ||
    alive(registry.config)
  );
}

export interface DockLike {
  isVisible: () => boolean;
  show: () => unknown;
  hide: () => void;
}

/**
 * DevBar is an accessory app: the Dock icon appears only while it owns a real
 * window, and goes away again when the last one closes.
 */
export function applyDockVisibility(
  dock: DockLike | null | undefined,
  anyOpen: boolean,
): void {
  if (!dock) return;
  if (anyOpen) {
    if (!dock.isVisible()) dock.show();
  } else {
    if (dock.isVisible()) dock.hide();
  }
}

/**
 * Apply the theme-appropriate opaque background to every visible app window
 * (macOS vibrancy windows keep their translucent background). Called after a
 * theme change so open windows follow the new setting.
 */
export function refreshWindowBackgrounds(
  registry: WindowRegistry,
  background: string,
): void {
  // The menubar popover is exposed as `.window` (there is no browserWindow
  // property — reading it silently skipped the popover from theme updates).
  for (const win of [
    registry.config,
    registry.trayPopover(),
    ...registry.logs.values(),
    ...registry.silenced.values(),
    ...registry.prescriptConfirm.values(),
  ]) {
    if (alive(win)) win.setBackgroundColor(background);
  }
}
