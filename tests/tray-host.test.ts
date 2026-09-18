// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HostModule = typeof import('../renderer/tray/host.js');

/**
 * `renderer/tray/host.ts` is the seam between the tray shell and the pieces
 * it renders: the shell installs its toast element and its render loop once,
 * and the row/branch modules call back through here instead of importing the
 * entry point (which would be a cycle).
 */
describe('renderer/tray/host.ts', () => {
  let host: HostModule;
  let toastEl: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="toast" style="display: none"></div>';
    const el = document.getElementById('toast');
    if (!el) throw new Error('no toast element');
    toastEl = el;
    vi.resetModules();
    host = await import('../renderer/tray/host.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('before the shell installs itself', () => {
    it('swallows a toast rather than throwing', () => {
      expect(() => {
        host.showToast('hola');
      }).not.toThrow();
      expect(toastEl.style.display).toBe('none');
    });

    it('swallows a repaint request', () => {
      expect(() => {
        host.rerenderTray();
      }).not.toThrow();
    });
  });

  describe('showToast', () => {
    beforeEach(() => {
      host.setTrayHost({ toastElement: toastEl, rerender: () => undefined });
    });

    it('shows the message', () => {
      host.showToast('Rama cambiada');
      expect(toastEl.textContent).toBe('Rama cambiada');
      expect(toastEl.style.display).toBe('block');
    });

    it('defaults to the ok styling', () => {
      host.showToast('Rama cambiada');
      expect(toastEl.className).toBe('toast ok');
    });

    it('carries the kind it was given', () => {
      host.showToast('Se rompió', 'error');
      expect(toastEl.className).toBe('toast error');
    });

    it('hides itself again after a few seconds', () => {
      host.showToast('Rama cambiada');
      vi.advanceTimersByTime(4000);
      expect(toastEl.style.display).toBe('none');
    });

    it('restarts the countdown instead of hiding on the first toast’s clock', () => {
      host.showToast('uno');
      vi.advanceTimersByTime(3000);
      host.showToast('dos');
      vi.advanceTimersByTime(3000);
      expect(toastEl.style.display).toBe('block');
      expect(toastEl.textContent).toBe('dos');
      vi.advanceTimersByTime(1000);
      expect(toastEl.style.display).toBe('none');
    });
  });

  describe('rerenderTray', () => {
    it('calls the shell’s render loop', () => {
      const rerender = vi.fn();
      host.setTrayHost({ toastElement: toastEl, rerender });
      host.rerenderTray();
      expect(rerender).toHaveBeenCalledTimes(1);
    });

    it('follows the shell when it installs a new one', () => {
      const first = vi.fn();
      const second = vi.fn();
      host.setTrayHost({ toastElement: toastEl, rerender: first });
      host.setTrayHost({ toastElement: toastEl, rerender: second });
      host.rerenderTray();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
