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

interface CustomBannerOptions {
  cta?: BannerCta;
  /**
   * Stays on screen until it is answered: no auto-close timer, and a transient
   * banner that takes its slot gives it back once it closes.
   */
  sticky?: boolean;
}

interface BannerOptions {
  cta?: BannerCta;
  /**
   * False when the caller keeps its own record of this notice (a connected
   * phone, which «Control remoto» logs for every phone but that one).
   */
  record?: boolean;
  /**
   * Stays on screen until it is answered: always the in-app banner (a system
   * notification may vanish on its own), with no auto-close timer.
   */
  sticky?: boolean;
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
  /** `confirmed`: the click came from the user on the update's own prompt. */
  applyUpdate: (confirmed: boolean) => void;
  /** The host OS: Linux compositors may be absent, which decides the
   *  window's transparency (see showCustomBanner). */
  platform: NodeJS.Platform;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Every notice that reaches the user, for «Control remoto»'s log. */
  onNotice?: (notice: {
    title: string;
    body: string;
    action: string | null;
  }) => void;
}

export interface Notifications {
  showBannerNotification: (
    title: string,
    body: string,
    options?: BannerOptions,
  ) => void;
  showCustomBanner: (
    title: string,
    body: string,
    options?: CustomBannerOptions,
  ) => void;
  /** Gated by the global `notifySuccess` toggle. */
  showCompletionNotification: (title: string, body: string) => void;
  closeNotificationWindow: () => void;
  /** The banner's ✕ (or any request to dismiss what is on screen). */
  dismissBanner: () => void;
  /**
   * A banner CTA arriving over IPC. Only the banner on screen, offering that
   * very action, counts as the user's answer; any other sender still runs it,
   * but an install then asks first.
   */
  answerBanner: (sender: unknown, action: string) => void;
  /** A CTA from either path (native click or banner button). */
  runNotificationAction: (action: string, confirmed?: boolean) => void;
}

export function createNotifications(deps: NotificationDeps): Notifications {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  let notificationWindow: BrowserWindow | null = null;
  let notificationTimer: NodeJS.Timeout | null = null;
  /** What the banner on screen offers, and whether it is the sticky one. */
  let shown: { action: string | null; sticky: boolean } = {
    action: null,
    sticky: false,
  };
  /** A sticky banner still waiting for its answer, to bring back. */
  let pendingSticky: {
    title: string;
    body: string;
    options: CustomBannerOptions;
  } | null = null;

  function closeNotificationWindow(): void {
    if (notificationTimer) {
      clearTimer(notificationTimer);
      notificationTimer = null;
    }
    const win = notificationWindow;
    notificationWindow = null;
    shown = { action: null, sticky: false };
    if (win && !win.isDestroyed()) win.close();
  }

  /** Single slot: once a transient banner is gone, the unanswered one returns. */
  function restoreSticky(): void {
    if (pendingSticky && !notificationWindow)
      showCustomBanner(
        pendingSticky.title,
        pendingSticky.body,
        pendingSticky.options,
      );
  }

  function dismissBanner(): void {
    if (shown.sticky) pendingSticky = null; // answered: it stays gone
    closeNotificationWindow();
    restoreSticky();
  }

  function showCustomBanner(
    title: string,
    body: string,
    options: CustomBannerOptions = {},
  ): void {
    const { cta, sticky = false } = options;
    if (sticky) pendingSticky = { title, body, options };
    closeNotificationWindow(); // replace any visible banner
    const secs = sticky ? 0 : BANNER_AUTOCLOSE_SECS;
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
      if (notificationWindow !== win) return;
      notificationWindow = null;
      shown = { action: null, sticky: false };
    });
    notificationWindow = win;
    shown = { action: cta?.action ?? null, sticky };

    // Main owns the authoritative close timer; the renderer bar is cosmetic.
    if (secs > 0)
      notificationTimer = setTimer(() => {
        closeNotificationWindow();
        restoreSticky();
      }, secs * 1000);
  }

  function runNotificationAction(action: string, confirmed = false): void {
    if (action === 'open-about') deps.openConfig('about');
    else if (action === 'open-changelog') deps.openConfig('about-changelog');
    else if (action === 'install-update') deps.applyUpdate(confirmed);
    else if (action === 'open-remote') deps.openConfig('remote');
  }

  function answerBanner(sender: unknown, action: string): void {
    const win = notificationWindow;
    const own =
      win !== null &&
      !win.isDestroyed() &&
      win.webContents === sender &&
      shown.action === action;
    runNotificationAction(action, own);
    if (own) dismissBanner();
  }

  /** Prefer the real macOS notification, fall back to our own banner. */
  function showBannerNotification(
    title: string,
    body: string,
    options: BannerOptions = {},
  ): void {
    if (options.record !== false)
      deps.onNotice?.({ title, body, action: options.cta?.action ?? null });
    if (options.sticky) {
      showCustomBanner(title, body, options);
      return;
    }
    if (!deps.notificationsSupported()) {
      console.log('[notify] sistema no soportado → banner propio');
      showCustomBanner(title, body, options);
      return;
    }
    let delivered = false;
    const notification = deps.createNotification({ title, body });
    const action = options.cta && options.cta.action;
    // A click on the system notification is the user's own answer.
    if (action)
      notification.on('click', () => runNotificationAction(action, true));
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
    dismissBanner,
    answerBanner,
    runNotificationAction,
    showCompletionNotification(title, body): void {
      if (!deps.notifySuccessEnabled()) return;
      showBannerNotification(title, body);
    },
  };
}
