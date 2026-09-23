import { errorMessage } from './ipc-validators.js';

/**
 * Open the OS notification settings for this app. Separate from
 * `app:openExternal`, which is deliberately https-only so a renderer bug cannot
 * fire arbitrary schemes — these URLs are constants built in main and never
 * come from the renderer.
 *
 * macOS deep-links to this app's own Notifications row (the bundle id is read
 * back from the running bundle rather than repeated here, so it cannot drift
 * from what was packaged). Windows opens the notifications settings page. Linux
 * has no universal URI, so we detect the desktop's own settings tool; when
 * nothing is known the caller reports a failure and the renderer shows the
 * manual navigation hint instead of a button that pretends to have worked.
 */

export type NotificationSettingsPlan =
  | { kind: 'url'; url: string }
  | { kind: 'spawn'; command: string; args: string[] }
  | { kind: 'unsupported' };

const MAC_PANE =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

export function notificationSettingsPlan(
  platform: NodeJS.Platform,
  desktop: string,
  bundleId: string | null,
): NotificationSettingsPlan {
  if (platform === 'darwin')
    return {
      kind: 'url',
      url: bundleId ? `${MAC_PANE}?id=${bundleId}` : MAC_PANE,
    };
  if (platform === 'win32')
    return { kind: 'url', url: 'ms-settings:notifications' };
  const name = desktop.toLowerCase();
  // Pane ids are lowercase names per gnome-control-center's man page.
  if (name.includes('gnome'))
    return {
      kind: 'spawn',
      command: 'gnome-control-center',
      args: ['notifications'],
    };
  // Plasma's System Settings KCM for notifications.
  if (name.includes('kde'))
    return { kind: 'spawn', command: 'kcmshell6', args: ['kcm_notify'] };
  return { kind: 'unsupported' };
}

/** The bit of a spawned child this flow actually observes. */
export interface SpawnedChild {
  once: (event: 'error' | 'spawn', listener: () => void) => unknown;
  unref: () => void;
}

export interface NotificationSettingsDeps {
  platform: NodeJS.Platform;
  desktop: string;
  bundleId: () => string | null;
  openExternal: (url: string) => Promise<unknown>;
  spawnDetached: (command: string, args: string[]) => SpawnedChild;
  spawnTimeoutMs?: number;
}

export async function openNotificationSettings(
  deps: NotificationSettingsDeps,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const plan = notificationSettingsPlan(
      deps.platform,
      deps.desktop,
      deps.bundleId(),
    );
    if (plan.kind === 'unsupported')
      return {
        ok: false,
        error: 'No se detectó un panel de notificaciones conocido',
      };
    if (plan.kind === 'url') {
      await deps.openExternal(plan.url);
      return { ok: true };
    }
    const child = deps.spawnDetached(plan.command, plan.args);
    // An absent binary arrives as an async 'error' (ENOENT) — surface it as a
    // failure instead of a silent success.
    const launched = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(true),
        deps.spawnTimeoutMs ?? 3000,
      );
      child.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    child.unref();
    if (!launched)
      return { ok: false, error: 'No se pudo abrir el panel del sistema' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
