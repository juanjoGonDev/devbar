// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { installJsdomGaps } from './helpers/logs-dom.js';

/**
 * `renderer/notification.ts` is the banner DevBar shows instead of a system
 * notification. Everything it displays comes out of its own query string, and
 * everything it does is one of two messages back to main — so the window is
 * opened here with a real query string and driven by clicking it.
 */
describe('renderer/notification.ts', () => {
  let banner: RendererWindow | null = null;

  afterEach(() => {
    banner?.close();
    banner = null;
  });

  async function openBanner(search: string): Promise<RendererWindow> {
    installJsdomGaps();
    window.history.replaceState({}, '', search);
    const win = await loadRendererWindow({
      html: 'notification.html',
      load: () => import('../renderer/notification.js'),
      values: { platform: 'macos' },
    });
    banner = win;
    return win;
  }

  function byId(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }

  describe('what it shows', () => {
    it('reads its text out of the query string', async () => {
      await openBanner('?title=Listo&body=todo%20bien');
      expect(byId('title').textContent).toBe('Listo');
      expect(byId('body').textContent).toBe('todo bien');
    });

    it('falls back to the app name when no title was given', async () => {
      await openBanner('?body=algo');
      expect(byId('title').textContent).toBe('DevBar');
      expect(byId('body').textContent).toBe('algo');
    });

    it('shows an empty body rather than the string "null"', async () => {
      await openBanner('?title=Listo');
      expect(byId('body').textContent).toBe('');
    });

    it('runs the progress bar for as long as the banner will live', async () => {
      await openBanner('?title=Listo&secs=6');
      expect(byId('progress').style.animation).toBe(
        'devbar-shrink 6s linear forwards',
      );
      expect(byId('progress').style.display).toBe('');
    });

    it('hides the bar entirely for a banner that does not expire', async () => {
      await openBanner('?title=Listo');
      expect(byId('progress').style.display).toBe('none');
    });

    it('hides a logo that failed to load instead of showing a broken image', async () => {
      await openBanner('?title=Listo');
      const logo = byId('logo');
      logo.dispatchEvent(new Event('error'));
      expect(logo.style.display).toBe('none');
    });
  });

  describe('what it does', () => {
    it('dismisses itself when the banner is clicked', async () => {
      const win = await openBanner('?title=Listo');
      byId('banner').click();
      expect(win.callCount('dismissNotification')).toBe(1);
    });

    it('dismisses itself from the close control', async () => {
      const win = await openBanner('?title=Listo');
      byId('close').click();
      expect(win.callCount('dismissNotification')).toBe(1);
    });

    it('offers the action it was given, and sends it back', async () => {
      const win = await openBanner('?title=Listo&cta=Reiniciar&action=restart');
      const cta = byId('cta');
      expect(cta.textContent).toBe('Reiniciar');
      expect(cta.style.display).toBe('');
      cta.click();
      expect(win.argsFor('notificationAction')).toEqual([['restart']]);
    });

    it('does not dismiss the banner out from under its own action', async () => {
      const win = await openBanner('?title=Listo&cta=Reiniciar&action=restart');
      byId('cta').click();
      expect(win.callCount('dismissNotification')).toBe(0);
    });

    it('keeps the action hidden when only half of it was given', async () => {
      const win = await openBanner('?title=Listo&cta=Reiniciar');
      expect(byId('cta').style.display).toBe('none');
      byId('cta').click();
      expect(win.callCount('notificationAction')).toBe(0);
    });
  });
});
