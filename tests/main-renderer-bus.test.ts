import { describe, expect, it, vi } from 'vitest';
import {
  anyAppWindowOpen,
  applyDockVisibility,
  createWindowRegistry,
  MAIN_LOGS_KEY,
  refreshWindowBackgrounds,
  rendererTargets,
  sendToRenderers,
  themeTargets,
  type WindowLike,
} from '../src/main/renderer-bus.js';
import { fakeWindow } from './helpers/main-fakes.js';

const asWindow = (win: ReturnType<typeof fakeWindow>): WindowLike => win;

describe('src/main/renderer-bus.ts', () => {
  describe('createWindowRegistry', () => {
    it('starts empty with no config window', () => {
      const registry = createWindowRegistry(() => null);
      expect(registry.config).toBeNull();
      expect(registry.logs.size).toBe(0);
      expect(registry.trayPopover()).toBeNull();
      expect(MAIN_LOGS_KEY).toBe('@main');
    });
  });

  describe('rendererTargets', () => {
    it('collects the popover, config and every log and silenced window', () => {
      const popover = fakeWindow('tray');
      const registry = createWindowRegistry(() => asWindow(popover));
      registry.config = asWindow(fakeWindow('config'));
      registry.logs.set(MAIN_LOGS_KEY, asWindow(fakeWindow('logs')));
      registry.silenced.set('g1:c1', asWindow(fakeWindow('silenced')));
      expect(rendererTargets(registry)).toHaveLength(4);
    });

    it('skips destroyed windows and a missing popover', () => {
      const dead = fakeWindow();
      dead.destroy();
      const registry = createWindowRegistry(() => null);
      registry.config = asWindow(dead);
      registry.logs.set('x', asWindow(dead));
      expect(rendererTargets(registry)).toEqual([]);
    });

    it('leaves the confirm modal out of the ordinary stream', () => {
      const registry = createWindowRegistry(() => null);
      registry.prescriptConfirm.set('t1', asWindow(fakeWindow('confirm')));
      expect(rendererTargets(registry)).toEqual([]);
    });
  });

  describe('themeTargets', () => {
    it('adds the confirm modal, which paints themed chrome', () => {
      const registry = createWindowRegistry(() => null);
      registry.prescriptConfirm.set('t1', asWindow(fakeWindow('confirm')));
      expect(themeTargets(registry)).toHaveLength(1);
    });

    it('skips a destroyed modal', () => {
      const dead = fakeWindow();
      dead.destroy();
      const registry = createWindowRegistry(() => null);
      registry.prescriptConfirm.set('t1', asWindow(dead));
      expect(themeTargets(registry)).toEqual([]);
    });
  });

  describe('sendToRenderers', () => {
    it('pushes the payload to every live renderer', () => {
      const config = fakeWindow('config');
      const registry = createWindowRegistry(() => null);
      registry.config = asWindow(config);
      sendToRenderers(registry, 'groups:toast', { kind: 'ok', message: 'hi' });
      expect(config.sent).toEqual([
        { channel: 'groups:toast', payload: { kind: 'ok', message: 'hi' } },
      ]);
    });
  });

  describe('anyAppWindowOpen', () => {
    it('ignores the tray popover, which is not a window', () => {
      const registry = createWindowRegistry(() => asWindow(fakeWindow('tray')));
      expect(anyAppWindowOpen(registry)).toBe(false);
    });

    it('counts logs, silenced, confirm modals and config', () => {
      for (const fill of [
        (r: ReturnType<typeof createWindowRegistry>) =>
          r.logs.set('x', asWindow(fakeWindow())),
        (r: ReturnType<typeof createWindowRegistry>) =>
          r.silenced.set('x', asWindow(fakeWindow())),
        (r: ReturnType<typeof createWindowRegistry>) =>
          r.prescriptConfirm.set('x', asWindow(fakeWindow())),
        (r: ReturnType<typeof createWindowRegistry>) => {
          r.config = asWindow(fakeWindow());
        },
      ]) {
        const registry = createWindowRegistry(() => null);
        fill(registry);
        expect(anyAppWindowOpen(registry)).toBe(true);
      }
    });

    it('treats a destroyed config window as closed', () => {
      const dead = fakeWindow();
      dead.destroy();
      const registry = createWindowRegistry(() => null);
      registry.config = asWindow(dead);
      expect(anyAppWindowOpen(registry)).toBe(false);
    });
  });

  describe('applyDockVisibility', () => {
    it('does nothing without a dock', () => {
      expect(() => applyDockVisibility(null, true)).not.toThrow();
    });

    it('shows the dock icon only while a window is open', () => {
      const dock = { visible: false, show: vi.fn(), hide: vi.fn() };
      const api = {
        isVisible: () => dock.visible,
        show: dock.show,
        hide: dock.hide,
      };
      applyDockVisibility(api, true);
      expect(dock.show).toHaveBeenCalledTimes(1);
      dock.visible = true;
      applyDockVisibility(api, true);
      expect(dock.show).toHaveBeenCalledTimes(1);
      applyDockVisibility(api, false);
      expect(dock.hide).toHaveBeenCalledTimes(1);
      dock.visible = false;
      applyDockVisibility(api, false);
      expect(dock.hide).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshWindowBackgrounds', () => {
    it('repaints every live window, including the popover', () => {
      const popover = fakeWindow('tray');
      const config = fakeWindow('config');
      const dead = fakeWindow();
      dead.destroy();
      const registry = createWindowRegistry(() => asWindow(popover));
      registry.config = asWindow(config);
      registry.logs.set('x', asWindow(dead));
      refreshWindowBackgrounds(registry, '#1e1e1e');
      expect(popover.background).toBe('#1e1e1e');
      expect(config.background).toBe('#1e1e1e');
      expect(dead.background).toBeNull();
    });
  });
});
