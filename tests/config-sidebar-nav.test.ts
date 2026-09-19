// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush, openConfigWindow, waitFor } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

function navItem(target: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `.nav-item[data-target="${target}"]`,
  );
  if (!el) throw new Error(`no nav item for ${target}`);
  return el;
}

function activeSections(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('.config-section.active'),
  ].map((s) => s.dataset.section ?? '');
}

function windowTitle(): string {
  return document.getElementById('window-title')?.textContent ?? '';
}

describe('renderer/config/sidebar-nav.ts', () => {
  let win: RendererWindow | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    win?.close();
    win = null;
    vi.restoreAllMocks();
  });

  describe('sections', () => {
    it('shows the clicked section and names it in the title bar', async () => {
      win = await openConfigWindow();
      navItem('about').click();
      expect(activeSections()).toEqual(['about']);
      expect(navItem('about').classList.contains('active')).toBe(true);
      expect(windowTitle()).toBe('Acerca de');
      expect(document.title).toBe('DevBar — Acerca de');
      expect(localStorage.getItem('config-section')).toBe('about');
    });

    it('reopens on the section it left on', async () => {
      localStorage.setItem('config-section', 'backup');
      win = await openConfigWindow();
      expect(activeSections()).toEqual(['backup']);
    });

    it('ignores a remembered section the window no longer has', async () => {
      localStorage.setItem('config-section', 'ghost');
      win = await openConfigWindow();
      expect(activeSections()).toEqual(['general']);
    });

    it('keeps the previous title when a nav item carries no label', async () => {
      win = await openConfigWindow();
      navItem('about').click();
      navItem('about').querySelector('.nav-label')?.remove();
      navItem('groups').click();
      navItem('about').click();
      expect(windowTitle()).toBe('Grupos');
    });
  });

  describe('collapsing', () => {
    it('folds and unfolds the nav, remembering which', async () => {
      win = await openConfigWindow();
      const toggle = document.getElementById('nav-collapse');
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.getElementById('config-nav')?.classList).toContain(
        'collapsed',
      );
      expect(toggle?.textContent).toBe('▨');
      expect(localStorage.getItem('config-nav-collapsed')).toBe('1');
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(toggle?.textContent).toBe('◧');
      expect(localStorage.getItem('config-nav-collapsed')).toBe('0');
    });

    it('reopens with the nav folded', async () => {
      localStorage.setItem('config-nav-collapsed', '1');
      win = await openConfigWindow();
      expect(document.getElementById('config-nav')?.classList).toContain(
        'collapsed',
      );
    });

    it('folds and unfolds the groups list, remembering which', async () => {
      win = await openConfigWindow();
      const toggle = document.getElementById('groups-collapse');
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.getElementById('groups-two-pane')?.classList).toContain(
        'list-collapsed',
      );
      expect(localStorage.getItem('groups-list-collapsed')).toBe('1');
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(
        document.getElementById('groups-two-pane')?.classList,
      ).not.toContain('list-collapsed');
    });

    it('reopens with the groups list folded', async () => {
      localStorage.setItem('groups-list-collapsed', '1');
      win = await openConfigWindow();
      expect(document.getElementById('groups-two-pane')?.classList).toContain(
        'list-collapsed',
      );
    });

    it('still navigates when the browser refuses local storage', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      win = await openConfigWindow();
      navItem('about').click();
      expect(activeSections()).toEqual(['about']);
      document
        .getElementById('nav-collapse')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.getElementById('config-nav')?.classList).toContain(
        'collapsed',
      );
    });
  });

  describe('deep links and external links', () => {
    it('opens the project page from the About section', async () => {
      win = await openConfigWindow();
      document
        .getElementById('about-github')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(win.callCount('openExternal')).toBe(1);
    });

    it('reports a failure through the one-click issue flow', async () => {
      win = await openConfigWindow();
      const btn = document.getElementById('report-issue') as HTMLButtonElement;
      expect(btn?.textContent).toContain('Reportar fallo');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await win.settle('reportIssue', { ok: true, bodyIncluded: false });
      expect(win.callCount('reportIssue')).toBe(1);
      // Feedback in place: the clipboard holds the report, GitHub is open.
      expect(btn.textContent).toContain('Copiado');
    });

    it('jumps to About when the tray asks for it', async () => {
      win = await openConfigWindow();
      await win.push('onConfigGoto', 'about');
      expect(activeSections()).toEqual(['about']);
      expect(document.querySelector('.modal-changelog')).toBeNull();
    });

    it('opens the changelog when the tray asks for it', async () => {
      win = await openConfigWindow();
      await win.settle('getAppVersion', '1.2.3');
      await win.push('onConfigGoto', 'about-changelog');
      expect(activeSections()).toEqual(['about']);
      expect(document.querySelector('.modal-changelog')).not.toBeNull();
      await win.settle('getChangelog', { releases: [], repoUrl: null });
    });

    it('ignores a target it does not know', async () => {
      win = await openConfigWindow();
      await win.push('onConfigGoto', 'somewhere-else');
      expect(activeSections()).toEqual(['general']);
    });
  });

  describe('dev panel', () => {
    it('stays out of the way in a packaged build', async () => {
      win = await openConfigWindow();
      await win.settle('isDev', false);
      await flush();
      expect(document.querySelector('[data-section="dev"]')).toBeNull();
    });

    it('mounts its own nav item and section in a dev build', async () => {
      win = await openConfigWindow();
      await win.settle('isDev', true);
      await waitFor(
        () => document.querySelector('.nav-item[data-target="dev"]') !== null,
      );
      const devNav = document.querySelector<HTMLElement>(
        '.nav-item[data-target="dev"]',
      );
      expect(devNav).not.toBeNull();
      devNav?.click();
      expect(activeSections()).toEqual(['dev']);
    });
  });
});
