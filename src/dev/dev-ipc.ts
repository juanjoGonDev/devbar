import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AvailableUpdate } from '../domain-types.js';
import type { TrayColor } from '../ipc-contract.js';

/**
 * Everything the simulation panel needs to reach back into the running app.
 * Injected by main so this module never imports main's mutable state — which
 * is also what lets the whole file be dropped from the packaged build.
 */
export interface DevHooks {
  /** null clears the simulation and hands control back to the real check. */
  setSimulatedUpdate(update: AvailableUpdate | null): void;
  /** null releases the override and repaints from the real aggregated state. */
  setSimulatedTrayColor(color: TrayColor | null): void;
  showBanner(
    title: string,
    body: string,
    options?: { cta?: { label: string; action: string } },
  ): void;
  showCompletionNotification(title: string, body: string): void;
  openPrescriptConfirm(name: string, command: string): void;
  toast(kind: string, message: string): void;
  currentVersion(): string;
}

const TRAY_COLORS: readonly TrayColor[] = [
  'stopped',
  'running',
  'warn',
  'error',
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

/** Bump the minor of a semver string; used for the default fake version. */
export function nextMinor(version: string): string {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  const [major, minor] = parts;
  if (
    parts.length !== 3 ||
    major === undefined ||
    minor === undefined ||
    Number.isNaN(major) ||
    Number.isNaN(minor)
  ) {
    return '99.0.0';
  }
  return `${major}.${minor + 1}.0`;
}

export function registerDevIpc(hooks: DevHooks): void {
  ipcMain.handle(
    'dev:simulateUpdate',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = asRecord(payload);
      const version = asString(raw.version, nextMinor(hooks.currentVersion()));
      hooks.setSimulatedUpdate({
        version,
        url: `https://github.com/juanjoGonDev/devbar/releases/tag/v${version}`,
        dmgUrl: null,
        zipUrl: null,
      });
      return { ok: true, version };
    },
  );

  ipcMain.handle('dev:clearUpdate', () => {
    hooks.setSimulatedUpdate(null);
    return { ok: true };
  });

  ipcMain.handle(
    'dev:simulateTrayColor',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = asRecord(payload);
      const value = raw.color;
      const color = TRAY_COLORS.find((candidate) => candidate === value);
      hooks.setSimulatedTrayColor(color ?? null);
      return { ok: true, color: color ?? null };
    },
  );

  ipcMain.handle(
    'dev:simulateBanner',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = asRecord(payload);
      const withCta = raw.cta === true;
      hooks.showBanner(
        'DevBar — prueba',
        withCta
          ? 'Banner de prueba con acción.'
          : 'Banner de prueba sin acción.',
        withCta ? { cta: { label: 'Ver', action: 'open-about' } } : undefined,
      );
      return { ok: true };
    },
  );

  // Goes through the same gate as a real success notification, so this also
  // tells you whether "avisar de acciones completadas" is switched on.
  ipcMain.handle('dev:simulateSuccess', () => {
    hooks.showCompletionNotification(
      'DevBar — prueba',
      'Notificación de éxito simulada.',
    );
    return { ok: true };
  });

  ipcMain.handle('dev:simulatePrescriptConfirm', () => {
    hooks.openPrescriptConfirm('Script de prueba', 'echo "hola desde dev"');
    return { ok: true };
  });

  ipcMain.handle('dev:simulateToast', (_e: IpcMainInvokeEvent, payload) => {
    const raw = asRecord(payload);
    const kind = asString(raw.kind, 'ok');
    hooks.toast(
      kind,
      kind === 'error' ? 'Toast de error simulado.' : 'Toast simulado.',
    );
    return { ok: true };
  });
}
