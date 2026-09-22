import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { GroupState } from '../ipc-contract.js';

/**
 * What the menubar mark says: the alert totals behind the badge, the strings
 * that render them, and the right-click menu's template. Everything here is a
 * value the tray then displays — `main.ts` keeps the `Tray` calls themselves,
 * so the counting and the wording can be checked without a menubar.
 */

export interface AlertTotals {
  warns: number;
  errs: number;
}

/**
 * Non-silenced warns/errors across every RUNNING command. A stopped command's
 * counters are history, not a live alert, so they never reach the tray.
 */
export function countAlerts(payload: readonly GroupState[]): AlertTotals {
  let warns = 0;
  let errs = 0;
  for (const gs of payload) {
    for (const cs of gs.commands || []) {
      if (cs.status !== 'running') continue;
      if (!cs.muteWarn) warns += cs.warnCount;
      if (!cs.muteErr) errs += cs.errorCount;
    }
  }
  return { warns, errs };
}

/** macOS carries the count as tray title text; empty means "no badge". */
export function trayTitleText(shown: number): string {
  return shown ? ` ${shown}` : '';
}

/**
 * Hover affordance where the count can't be displayed next to the icon: the
 * tray tooltip carries it too. The noun follows the count's source:
 * `badgeCount` falls back to warns when there are no errors, so a warning-only
 * badge labelled "errores" would misreport the state.
 */
export function trayTooltip(shown: number, fromErrors: boolean): string {
  if (!shown) return 'DevBar';
  const noun =
    shown === 1
      ? fromErrors
        ? '1 error'
        : '1 aviso'
      : fromErrors
        ? `${shown} errores`
        : `${shown} avisos`;
  return `DevBar — ${noun}`;
}

/** The minimum a logs window has to offer to appear in the tray menu. */
export interface TrayMenuWindow {
  isDestroyed: () => boolean;
  getTitle: () => string;
  show: () => void;
  focus: () => void;
}

export interface TrayMenuInput {
  availableUpdate: { version: string } | null;
  stagedUpdate: { version: string } | null;
  /** `[processId, window]` pairs, in insertion order. */
  logWindows: readonly (readonly [string, TrayMenuWindow])[];
  onApplyUpdate: () => void;
  onOpenConfig: () => void;
}

/**
 * The tray's right-click menu, assembled fresh per open so update state
 * and the open log windows are current. Lives here (next to the template
 * builder) to keep main.ts under its line budget.
 */
export function buildTrayContextMenu(
  deps: {
    [
      K in keyof Omit<TrayMenuInput, 'onApplyUpdate' | 'onOpenConfig'>
    ]: () => TrayMenuInput[K];
  } & Pick<TrayMenuInput, 'onApplyUpdate' | 'onOpenConfig'>,
): ReturnType<typeof Menu.buildFromTemplate> {
  return Menu.buildFromTemplate(
    buildTrayMenuTemplate({
      availableUpdate: deps.availableUpdate(),
      stagedUpdate: deps.stagedUpdate(),
      logWindows: deps.logWindows(),
      onApplyUpdate: deps.onApplyUpdate,
      onOpenConfig: deps.onOpenConfig,
    }),
  );
}

export function buildTrayMenuTemplate({
  availableUpdate,
  stagedUpdate,
  logWindows,
  onApplyUpdate,
  onOpenConfig,
}: TrayMenuInput): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (availableUpdate) {
    const ready =
      stagedUpdate !== null && stagedUpdate.version === availableUpdate.version;
    items.push({
      label: ready
        ? `⬆︎ Reiniciar e instalar v${availableUpdate.version}`
        : `⬆︎ Actualizar a v${availableUpdate.version}…`,
      click: () => onApplyUpdate(),
    });
    items.push({ type: 'separator' });
  }
  const submenu: MenuItemConstructorOptions[] = [];
  for (const [processId, win] of logWindows) {
    if (!win || win.isDestroyed()) continue;
    const title = win.getTitle() || `Logs — ${processId}`;
    submenu.push({
      label: title,
      click: () => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      },
    });
  }
  if (submenu.length > 0) {
    items.push({ label: 'Ventanas de logs', submenu });
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Configuración…', click: () => onOpenConfig() });
  items.push({ type: 'separator' });
  items.push({ label: 'Salir', role: 'quit' });
  return items;
}
