import { describe, expect, it, vi } from 'vitest';
import {
  buildTrayMenuTemplate,
  countAlerts,
  trayTitleText,
  trayTooltip,
  type TrayMenuWindow,
} from '../src/main/tray-view.js';
import type { GroupState } from '../src/ipc-contract.js';
import { makeGroup } from './helpers/main-fakes.js';

function groupState(
  commands: Partial<GroupState['commands'][number]>[],
): GroupState {
  return {
    groupId: 'g1',
    group: makeGroup(),
    currentBranch: null,
    color: 'running',
    commands: commands.map((command, index) => ({
      commandId: `c${index}`,
      processId: `g1:c${index}`,
      status: 'running',
      warnCount: 0,
      errorCount: 0,
      lastError: null,
      startedAt: null,
      color: 'running',
      muteWarn: false,
      muteErr: false,
      ...command,
    })),
    actions: [],
    lastError: null,
  };
}

function menuWindow(title: string, destroyed = false): TrayMenuWindow {
  return {
    isDestroyed: () => destroyed,
    getTitle: () => title,
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe('src/main/tray-view.ts', () => {
  describe('countAlerts', () => {
    it('sums warns and errors across groups', () => {
      expect(
        countAlerts([
          groupState([{ warnCount: 2, errorCount: 1 }]),
          groupState([{ warnCount: 3, errorCount: 0 }]),
        ]),
      ).toEqual({ warns: 5, errs: 1 });
    });

    it('ignores commands that are not running', () => {
      expect(
        countAlerts([
          groupState([{ status: 'stopped', warnCount: 9, errorCount: 9 }]),
        ]),
      ).toEqual({ warns: 0, errs: 0 });
    });

    it('drops the silenced half of a command, not the whole command', () => {
      expect(
        countAlerts([
          groupState([
            { warnCount: 4, errorCount: 7, muteWarn: true, muteErr: false },
          ]),
        ]),
      ).toEqual({ warns: 0, errs: 7 });
    });

    it('returns zeros for an empty payload', () => {
      expect(countAlerts([])).toEqual({ warns: 0, errs: 0 });
    });
  });

  describe('trayTitleText', () => {
    it('renders the count with its leading space, and nothing at zero', () => {
      expect(trayTitleText(3)).toBe(' 3');
      expect(trayTitleText(0)).toBe('');
    });
  });

  describe('trayTooltip', () => {
    it('names errors and warnings apart, in singular and plural', () => {
      expect(trayTooltip(1, true)).toBe('DevBar — 1 error');
      expect(trayTooltip(1, false)).toBe('DevBar — 1 aviso');
      expect(trayTooltip(4, true)).toBe('DevBar — 4 errores');
      expect(trayTooltip(4, false)).toBe('DevBar — 4 avisos');
    });

    it('falls back to the bare name with no badge', () => {
      expect(trayTooltip(0, true)).toBe('DevBar');
    });
  });

  describe('buildTrayMenuTemplate', () => {
    const base = {
      availableUpdate: null,
      stagedUpdate: null,
      logWindows: [],
      onApplyUpdate: () => undefined,
      onOpenConfig: () => undefined,
    };

    it('shows configuration and quit when there is nothing else', () => {
      expect(
        buildTrayMenuTemplate(base).map((item) => item.label ?? item.type),
      ).toEqual(['Configuración…', 'separator', 'Salir']);
    });

    it('offers a download while the update is not staged yet', () => {
      const [first] = buildTrayMenuTemplate({
        ...base,
        availableUpdate: { version: '1.2.0' },
      });
      expect(first?.label).toBe('⬆︎ Actualizar a v1.2.0…');
    });

    it('offers a restart once the staged version matches', () => {
      const [first] = buildTrayMenuTemplate({
        ...base,
        availableUpdate: { version: '1.2.0' },
        stagedUpdate: { version: '1.2.0' },
      });
      expect(first?.label).toBe('⬆︎ Reiniciar e instalar v1.2.0');
    });

    it('still offers the download when a DIFFERENT version is staged', () => {
      const [first] = buildTrayMenuTemplate({
        ...base,
        availableUpdate: { version: '1.3.0' },
        stagedUpdate: { version: '1.2.0' },
      });
      expect(first?.label).toBe('⬆︎ Actualizar a v1.3.0…');
    });

    it('runs the update callback when the entry is clicked', () => {
      const onApplyUpdate = vi.fn();
      const [first] = buildTrayMenuTemplate({
        ...base,
        availableUpdate: { version: '1.2.0' },
        onApplyUpdate,
      });
      (first?.click as (() => void) | undefined)?.();
      expect(onApplyUpdate).toHaveBeenCalledTimes(1);
    });

    it('lists live log windows and focuses the one clicked', () => {
      const win = menuWindow('Logs — web');
      const items = buildTrayMenuTemplate({
        ...base,
        logWindows: [['g1:c1', win]],
      });
      const submenu = items[0]?.submenu as {
        label?: string;
        click?: () => void;
      }[];
      expect(items[0]?.label).toBe('Ventanas de logs');
      submenu[0]?.click?.();
      expect(win.show).toHaveBeenCalledTimes(1);
      expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('falls back to the process id when the window has no title', () => {
      const items = buildTrayMenuTemplate({
        ...base,
        logWindows: [['g1:c1', menuWindow('')]],
      });
      const submenu = items[0]?.submenu as { label?: string }[];
      expect(submenu[0]?.label).toBe('Logs — g1:c1');
    });

    it('omits destroyed windows, and the whole submenu when none survive', () => {
      const items = buildTrayMenuTemplate({
        ...base,
        logWindows: [['g1:c1', menuWindow('gone', true)]],
      });
      expect(items.map((item) => item.label ?? item.type)).toEqual([
        'Configuración…',
        'separator',
        'Salir',
      ]);
    });

    it('does not focus a window destroyed between build and click', () => {
      let destroyed = false;
      const win: TrayMenuWindow = {
        isDestroyed: () => destroyed,
        getTitle: () => 'Logs — web',
        show: vi.fn(),
        focus: vi.fn(),
      };
      const items = buildTrayMenuTemplate({
        ...base,
        logWindows: [['g1:c1', win]],
      });
      const submenu = items[0]?.submenu as { click?: () => void }[];
      destroyed = true;
      submenu[0]?.click?.();
      expect(win.show).not.toHaveBeenCalled();
    });

    it('runs the config callback from its entry', () => {
      const onOpenConfig = vi.fn();
      const items = buildTrayMenuTemplate({ ...base, onOpenConfig });
      (items[0]?.click as (() => void) | undefined)?.();
      expect(onOpenConfig).toHaveBeenCalledTimes(1);
    });
  });
});
