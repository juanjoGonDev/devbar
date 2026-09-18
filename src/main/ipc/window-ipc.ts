import type { IpcMainInvokeEvent } from 'electron';
import {
  ipcNumber,
  ipcRecord,
  ipcString,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';
import { trayPopoverHeight, type Rect } from '../window-geometry.js';
import type { Group } from '../../domain-types.js';

/**
 * Opening, sizing and closing windows on the renderer's behalf, plus the two
 * notification entry points the banner renderer itself calls back on.
 *
 * Every "open a window" handler also hides the tray popover: the popover is a
 * transient surface, and leaving it up over a window the user just asked for
 * is the kind of thing only a real click reveals.
 */

interface PopoverLike {
  isDestroyed: () => boolean;
  getBounds: () => Rect;
  setSize: (width: number, height: number, animate?: boolean) => void;
}

export interface WindowIpcDeps {
  configStore: { getGroup(id: string): Group | null };
  appWindows: {
    ensureConfigWindow: (options?: { goto?: string }) => void;
    confirmCloseConfig: () => void;
    ensureSilencedWindow: (groupId: string, commandId: string) => unknown;
  };
  logWindows: {
    ensureLogsWindow: (
      processId: string,
      options?: {
        filter?: string | undefined;
        detached?: boolean | undefined;
        level?: 'warn' | 'error' | undefined;
      },
    ) => unknown;
    ensureLogsScopeWindow: (
      scope: 'all' | 'group',
      groupId: string | null,
      level: 'warn' | 'error' | null,
    ) => unknown;
  };
  notifications: {
    showBannerNotification: (title: string, body: string) => void;
    closeNotificationWindow: () => void;
    runNotificationAction: (action: string) => void;
  };
  trayHost: {
    /** Hides the tray popover, but only when it is on screen. */
    hideIfVisible: () => void;
    /** Hides the tray popover unconditionally (the renderer asked for it). */
    hide: () => void;
    popover: () => PopoverLike | null;
    /** Work-area height of the display the popover sits on. */
    workAreaHeight: (bounds: Rect) => number;
  };
  showMessageBoxForSender: (
    sender: unknown,
    options: {
      type: 'question' | 'warning';
      buttons: string[];
      cancelId: number;
      defaultId: number;
      message: string;
      detail: string;
    },
  ) => Promise<{ response: number }>;
}

export function registerWindowIpc(
  ipc: IpcRegistrar,
  deps: WindowIpcDeps,
): void {
  const openThenHideTray = (open: () => void) => (): { ok: boolean } => {
    open();
    deps.trayHost.hideIfVisible();
    return { ok: true };
  };

  ipc.handle(
    'window:openConfig',
    openThenHideTray(() => deps.appWindows.ensureConfigWindow()),
  );
  // Tray version chip: open config on "Acerca de" with the changelog modal.
  ipc.handle(
    'window:openConfigChangelog',
    openThenHideTray(() =>
      deps.appWindows.ensureConfigWindow({ goto: 'about-changelog' }),
    ),
  );

  ipc.handle('window:hideTray', () => {
    deps.trayHost.hide();
    return { ok: true };
  });

  // The renderer measures its natural scrollHeight after every render and sends
  // it here so the popover grows / shrinks to fit.
  ipc.handle(
    'tray:setHeight',
    (_e: IpcMainInvokeEvent, rawContentHeight: unknown) => {
      const contentHeight = ipcNumber(rawContentHeight, 'contentHeight');
      const popover = deps.trayHost.popover();
      // menubar keeps handing back its `window` after Electron destroyed it,
      // and every call on that throws — so a destroyed popover is no popover.
      if (!popover || popover.isDestroyed()) return { ok: false };
      const bounds = popover.getBounds();
      const desired = trayPopoverHeight(
        contentHeight,
        deps.trayHost.workAreaHeight(bounds),
      );
      if (desired !== bounds.height) {
        popover.setSize(bounds.width, desired, false);
      }
      return { ok: true, applied: desired };
    },
  );

  ipc.handle('window:openLogs', (_e: IpcMainInvokeEvent, payload: unknown) => {
    // Scope form: open the shared window on a merged view instead of one
    // service. Used by the tray's telemetry button and its alert totals.
    const record = typeof payload === 'string' ? {} : ipcRecord(payload);
    if (typeof record.scope === 'string') {
      const scope = record.scope === 'group' ? 'group' : 'all';
      deps.logWindows.ensureLogsScopeWindow(
        scope,
        scope === 'group' ? ipcStringField(payload, 'groupId') : null,
        record.level === 'warn' || record.level === 'error'
          ? record.level
          : null,
      );
      deps.trayHost.hideIfVisible();
      return { ok: true };
    }
    const processId =
      typeof payload === 'string'
        ? payload
        : ipcStringField(payload, 'processId');
    const rawFilter = typeof payload === 'string' ? undefined : record.filter;
    const filter =
      rawFilter === undefined ? undefined : ipcString(rawFilter, 'filter');
    const detached =
      typeof payload === 'string' ? false : record.detached === true;
    const rawLevel = typeof payload === 'string' ? undefined : record.level;
    const level =
      rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : undefined;
    deps.logWindows.ensureLogsWindow(processId, {
      ...(filter === undefined ? {} : { filter }),
      ...(detached ? { detached: true } : {}),
      ...(level === undefined ? {} : { level }),
    });
    deps.trayHost.hideIfVisible();
    return { ok: true };
  });

  ipc.handle(
    'window:openSilenced',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const win = deps.appWindows.ensureSilencedWindow(
        ipcStringField(payload, 'groupId'),
        ipcStringField(payload, 'commandId'),
      );
      return win ? { ok: true } : { ok: false, error: 'command not found' };
    },
  );

  ipc.handle(
    'silenced:getForCommand',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const group = deps.configStore.getGroup(groupId);
      const command =
        group &&
        group.commands &&
        group.commands.find((c) => c.id === commandId);
      if (!group || !command) return { ok: false, error: 'command not found' };
      return {
        ok: true,
        group: { id: group.id, name: group.name },
        command: {
          id: command.id,
          name: command.name,
          silencedPatterns: command.silencedPatterns || { warn: [], error: [] },
        },
      };
    },
  );

  // Show a test banner (ungated by notifySuccess — it's an explicit test).
  ipc.handle('notifications:test', () => {
    deps.notifications.showBannerNotification(
      'DevBar',
      'Notificación de prueba ✅',
    );
    return { ok: true };
  });

  // Dismiss the current completion banner (clicked in the banner renderer).
  ipc.handle('notification:dismiss', () => {
    deps.notifications.closeNotificationWindow();
    return { ok: true };
  });

  // A banner CTA was clicked → run the mapped action, then dismiss.
  ipc.handle(
    'notification:action',
    (_e: IpcMainInvokeEvent, rawAction: unknown) => {
      deps.notifications.runNotificationAction(
        ipcString(rawAction, 'notification action'),
      );
      deps.notifications.closeNotificationWindow();
      return { ok: true };
    },
  );

  // ── Config dirty-close helpers ─────────────────────────────────────────
  ipc.handle(
    'config:confirmDirty',
    async (event: IpcMainInvokeEvent, payload: unknown) => {
      const context = ipcRecord(payload).context;
      let res;
      try {
        res = await deps.showMessageBoxForSender(event.sender, {
          type: 'warning',
          buttons: ['Cancelar', 'Descartar', 'Guardar'],
          cancelId: 0,
          defaultId: 2,
          message: 'Tienes cambios sin guardar.',
          detail:
            context === 'window-close'
              ? '¿Quieres guardarlos antes de cerrar la ventana?'
              : '¿Quieres guardarlos antes de cambiar de grupo?',
        });
      } catch (err) {
        return { choice: 'cancel' };
      }
      return { choice: ['cancel', 'discard', 'save'][res.response] };
    },
  );

  ipc.handle('window:confirmCloseConfig', () => {
    deps.appWindows.confirmCloseConfig();
    return { ok: true };
  });
}
