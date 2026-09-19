import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Notification,
  NotificationConstructorOptions,
} from 'electron';
import { bannerBounds, type Rect } from './window-geometry.js';

/**
 * Completion / update notices, and the in-app banner that stands in when macOS
 * refuses a native notification — chiefly an unpackaged dev run, whose bundle
 * keeps Electron's own identity.
 *
 * Two things have to hold for the real notification, and both are free — no
 * Apple Developer account: every bundle ad-hoc signed as ITSELF, and a bundle
 * id macOS has not already recorded a "deny" against. The second one is the
 * trap: authorisation is stored per bundle id and the system asks exactly once,
 * so a rejected early build poisons the id forever after, and from then on
 * every notification is accepted and none is drawn — silently, since `failed`
 * does not fire on a drop and `show` only means the payload was accepted.
 *
 * Native notifications obey Do Not Disturb; the banner never did.
 *
 * Single-slot: a new banner replaces the current one; no stacking. Duration is
 * fixed rather than configurable — on the path users actually see, macOS owns
 * it through the app's notification style, and a setting that governed only the
 * fallback would be claiming more than it does.
 */
const BANNER_AUTOCLOSE_SECS = 5;

interface BannerCta {
  label: string;
  action: string;
}

export interface NotificationDeps {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  createNotification: (options: NotificationConstructorOptions) => Notification;
  notificationsSupported: () => boolean;
  rendererFile: (name: string) => string;
  preloadPath: string;
  workArea: () => Rect;
  notifySuccessEnabled: () => boolean;
  openConfig: (goto: string) => void;
  applyUpdate: () => void;
  /** The host OS: Linux compositors may be absent, which decides the
   *  window's transparency (see showCustomBanner). */
  platform: NodeJS.Platform;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export interface Notifications {
  showBannerNotification: (
    title: string,
    body: string,
    options?: { cta?: BannerCta },
  ) => void;
  showCustomBanner: (
    title: string,
    body: string,
    options?: { cta?: BannerCta },
  ) => void;
  /** Gated by the global `notifySuccess` toggle. */
  showCompletionNotification: (title: string, body: string) => void;
  closeNotificationWindow: () => void;
  /** A CTA from either path (native click or banner button). */
  runNotificationAction: (action: string) => void;
}

export function createNotifications(deps: NotificationDeps): Notifications {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  let notificationWindow: BrowserWindow | null = null;
  let notificationTimer: NodeJS.Timeout | null = null;

  function closeNotificationWindow(): void {
    if (notificationTimer) {
      clearTimer(notificationTimer);
      notificationTimer = null;
    }
    const win = notificationWindow;
    notificationWindow = null;
    if (win && !win.isDestroyed()) win.close();
  }

  function showCustomBanner(
    title: string,
    body: string,
    { cta }: { cta?: BannerCta } = {},
  ): void {
    closeNotificationWindow(); // replace any visible banner
    const secs = BANNER_AUTOCLOSE_SECS;
    const bounds = bannerBounds(deps.workArea());
    // Linux sessions often run WITHOUT a compositor (Raspberry Pi OS among
    // them), and a transparent window over no compositor is a solid black
    // rectangle — the banner rendered as a black box there. So Linux gets an
    // OPAQUE window (square corners, no float margin — the banner fills it,
    // mirrored by renderer/notification.html's html.linux rules); macOS and
    // Windows always composite and keep the floating rounded banner.
    const opaque = deps.platform === 'linux';
    const win = deps.createWindow({
      ...bounds,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      transparent: !opaque,
      hasShadow: true,
      backgroundColor: opaque ? '#1e1e1e' : '#00000000',
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const query: Record<string, string> = { title, body, secs: String(secs) };
    if (cta && cta.label && cta.action) {
      query.cta = cta.label;
      query.action = cta.action;
    }
    void win.loadFile(deps.rendererFile('notification.html'), { query });
    win.once('ready-to-show', () => win.showInactive()); // never steal focus
    win.on('closed', () => {
      if (notificationWindow === win) notificationWindow = null;
    });
    notificationWindow = win;

    // Main owns the authoritative close timer; the renderer bar is cosmetic.
    if (secs > 0)
      notificationTimer = setTimer(closeNotificationWindow, secs * 1000);
  }

  function runNotificationAction(action: string): void {
    if (action === 'open-about') deps.openConfig('about');
    else if (action === 'open-changelog') deps.openConfig('about-changelog');
    else if (action === 'install-update') deps.applyUpdate();
  }

  /** Prefer the real macOS notification, fall back to our own banner. */
  function showBannerNotification(
    title: string,
    body: string,
    options: { cta?: BannerCta } = {},
  ): void {
    if (!deps.notificationsSupported()) {
      console.log('[notify] sistema no soportado → banner propio');
      showCustomBanner(title, body, options);
      return;
    }
    let delivered = false;
    const notification = deps.createNotification({ title, body });
    const action = options.cta && options.cta.action;
    if (action) notification.on('click', () => runNotificationAction(action));
    notification.on('show', () => {
      delivered = true;
      console.log('[notify] aceptada por el sistema');
    });
    notification.on('failed', (_event, error) => {
      console.warn(`[notify] el sistema la rechazó (${error}) → banner propio`);
      if (!delivered) showCustomBanner(title, body, options);
    });
    notification.show();
  }

  return {
    showBannerNotification,
    showCustomBanner,
    closeNotificationWindow,
    runNotificationAction,
    showCompletionNotification(title, body): void {
      if (!deps.notifySuccessEnabled()) return;
      showBannerNotification(title, body);
    },
  };
}
