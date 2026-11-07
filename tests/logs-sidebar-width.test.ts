// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSidebarWidth,
  type SidebarWidthElements,
} from '../renderer/logs/sidebar-width.js';

const KEY = 'logs-list-width';

function stubWidth(el: Element, offsetWidth: number, clientWidth = 0): void {
  Object.defineProperty(el, 'offsetWidth', {
    configurable: true,
    value: offsetWidth,
  });
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: clientWidth,
  });
}

function get(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  return el;
}

/**
 * The sidebar the way `sidebar-rows.ts` draws it: «Todo», then a group whose
 * header and services each name themselves. Every row is 244px wide inside a
 * 260px sidebar and its name box takes 100px of it, so a row's own chrome is
 * 144px and the tree's gutter 16px.
 */
function mount(service: string): SidebarWidthElements {
  document.body.innerHTML = `
    <div id="shell">
      <aside id="sidebar">
        <div id="side-tree">
          <button class="side-all"><span class="a-name">Todo</span></button>
          <details class="side-group" open>
            <summary><span class="g-main"><span class="g-name">Back</span></span></summary>
            <div class="side-items">
              <div class="side-item"><span class="s-head"><span class="s-name">${service}</span></span></div>
            </div>
          </details>
        </div>
      </aside>
      <div id="handle" tabindex="0"></div>
    </div>`;
  const sidebar = get('sidebar');
  stubWidth(sidebar, 260, 260);
  for (const row of sidebar.querySelectorAll(
    '.side-all, .side-group > summary, .side-item',
  )) {
    stubWidth(row, 244);
    const name = row.querySelector('.a-name, .g-name, .s-name');
    if (name) stubWidth(name, 100);
  }
  return {
    shell: get('shell'),
    sidebar,
    handle: get('handle'),
    tree: get('side-tree'),
  };
}

const measureText = (el: HTMLElement): number =>
  (el.textContent ?? '').length * 10;

function width(els: SidebarWidthElements): number {
  return Number(els.handle.getAttribute('aria-valuenow'));
}

function rename(els: SidebarWidthElements, service: string): void {
  const name = els.tree.querySelector('.s-name');
  if (name) name.textContent = service;
}

describe('renderer/logs/sidebar-width.ts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('default width', () => {
    it('fits the longest name when the user never resized', () => {
      const els = mount('frontend-monorepo');
      createSidebarWidth({ ...els, measureText });
      // 17 chars × 10px + 144px of row chrome + 16px of tree gutter.
      expect(width(els)).toBe(330);
      expect(els.shell.style.getPropertyValue('--logs-list-width')).toBe(
        '330px',
      );
    });

    it('never goes narrower than 180px', () => {
      const els = mount('api');
      // Names that take no room at all still leave 160px of chrome.
      createSidebarWidth({ ...els, measureText: () => 0 });
      expect(width(els)).toBe(180);
    });

    it('never goes wider than 360px, so the log keeps its room', () => {
      const els = mount('a-service-with-a-really-long-name');
      createSidebarWidth({ ...els, measureText });
      expect(width(els)).toBe(360);
    });

    it('keeps the current width while the sidebar is hidden', () => {
      const els = mount('frontend-monorepo');
      stubWidth(els.sidebar, 0, 0);
      createSidebarWidth({ ...els, measureText });
      expect(width(els)).toBe(244);
    });

    it('follows the list as it changes', () => {
      const els = mount('api');
      const sidebarWidth = createSidebarWidth({ ...els, measureText });
      rename(els, 'frontend-monorepo');
      sidebarWidth.refresh();
      expect(width(els)).toBe(330);
    });

    it('re-fits when a group opens or closes', () => {
      const els = mount('frontend-monorepo');
      createSidebarWidth({ ...els, measureText });
      const item = els.tree.querySelector('.side-item');
      if (item) stubWidth(item, 0); // a closed group lays its rows out no more
      els.tree
        .querySelector('details')
        ?.dispatchEvent(new Event('toggle', { bubbles: false }));
      expect(width(els)).toBe(200);
    });

    it('exposes the range to assistive technology', () => {
      const els = mount('api');
      createSidebarWidth({ ...els, measureText });
      expect(els.handle.getAttribute('aria-valuemin')).toBe('180');
      expect(els.handle.getAttribute('aria-valuemax')).toBe('360');
    });
  });

  describe('a width the user chose', () => {
    it('reopens at the stored width and stops following the list', () => {
      localStorage.setItem(KEY, '250');
      const els = mount('api');
      const sidebarWidth = createSidebarWidth({ ...els, measureText });
      rename(els, 'frontend-monorepo');
      sidebarWidth.refresh();
      expect(width(els)).toBe(250);
    });

    it('remembers a drag under its own key', () => {
      const els = mount('api');
      createSidebarWidth({ ...els, measureText });
      els.handle.dispatchEvent(
        new MouseEvent('pointerdown', { clientX: 300, bubbles: true }),
      );
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 340 }));
      expect(els.shell.classList.contains('is-resizing')).toBe(true);
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 340 }));
      expect(width(els)).toBe(240);
      expect(localStorage.getItem(KEY)).toBe('240');
      expect(localStorage.getItem('groups-list-width')).toBeNull();
    });

    it('widens by 16px on ArrowRight', () => {
      const els = mount('api');
      createSidebarWidth({ ...els, measureText });
      els.handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      expect(width(els)).toBe(216);
      expect(localStorage.getItem(KEY)).toBe('216');
    });

    it('goes back to the auto width on double-click and forgets the choice', () => {
      localStorage.setItem(KEY, '300');
      const els = mount('api');
      createSidebarWidth({ ...els, measureText });
      els.handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(width(els)).toBe(200);
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('still resizes when the browser refuses local storage', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const els = mount('api');
      createSidebarWidth({ ...els, measureText });
      els.handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
      expect(width(els)).toBe(184);
    });
  });
});
