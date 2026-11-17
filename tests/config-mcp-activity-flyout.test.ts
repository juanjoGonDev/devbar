// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditEntry, click, el, visible } from './helpers/mcp.js';
import {
  auditPage,
  funnel,
  menu,
  menuButton,
  openActivity,
  openMenu,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import { placeMenu } from '../renderer/config/mcp-activity-place.js';

/**
 * Column menus that always fit in the window
 * (renderer/config/mcp-activity-place.ts): every menu is capped at the room
 * under it, and the «Rango…» picker of «Hora» opens in a fixed flyout beside
 * the menu — right of it, else left, and never past the bottom. jsdom has no
 * layout, so the boxes and the window size are stubbed.
 */

const NOW = new Date(2026, 10, 6, 9, 0).getTime();

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The boxes the stubbed layout hands out, by what the element is. */
interface Layout {
  menu: Box;
  /** Top of the «Filtrar» section that holds the flyout. */
  filterTop: number;
  fly: { width: number; height: number };
}

const layout = (): Layout => ({
  menu: { left: 40, top: 100, width: 268, height: 220 },
  filterTop: 170,
  fly: { width: 284, height: 330 },
});

let current: Layout = layout();

function rect({ left, top, width, height }: Box): DOMRect {
  return new DOMRect(left, top, width, height);
}

function stubLayout(width: number, height: number): void {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('xf')) return rect(current.menu);
      if (this.classList.contains('xf-fly'))
        return rect({ left: 0, top: 0, ...current.fly });
      if (this.classList.contains('xf-sec') && this.querySelector('.xf-fly'))
        return rect({ ...current.menu, top: current.filterTop, height: 60 });
      return new DOMRect();
    },
  );
}

function resize(width: number, height: number): void {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  window.dispatchEvent(new Event('resize'));
}

/** A menu with a «Filtrar» section holding a flyout, as menuContent builds. */
function bareMenu(withFlyout = true): HTMLElement {
  const box = document.createElement('div');
  box.className = 'xf';
  const sec = document.createElement('div');
  sec.className = 'xf-sec';
  if (withFlyout) {
    const fly = document.createElement('div');
    fly.className = 'xf-fly';
    sec.append(fly);
  }
  box.append(sec);
  document.body.append(box);
  return box;
}

const flyOf = (box: ParentNode): HTMLElement => {
  const found = box.querySelector<HTMLElement>('.xf-fly');
  if (!found) throw new Error('no flyout');
  return found;
};
const at = (fly: HTMLElement): [string, string] => [
  fly.style.left,
  fly.style.top,
];

describe('renderer/config/mcp-activity-place.ts', () => {
  beforeEach(() => {
    current = layout();
    stubLayout(1000, 620);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('placeMenu', () => {
    it('caps a menu at the room under it, keeping a margin', () => {
      const box = bareMenu(false);
      placeMenu(box);
      // 620 high, the menu starts at 100, 12px kept free.
      expect(box.style.maxHeight).toBe('508px');
    });

    it('never gives a menu below the window a negative height', () => {
      current.menu.top = 700;
      const box = bareMenu(false);
      placeMenu(box);
      expect(box.style.maxHeight).toBe('0px');
    });

    it('opens the flyout right of the menu, level with «Filtrar»', () => {
      const box = bareMenu();
      placeMenu(box);
      // The menu ends at 308; 6px of gap.
      expect(at(flyOf(box))).toEqual(['314px', '170px']);
    });

    it('opens it on the left when the right has no room', () => {
      current.menu.left = 400;
      stubLayout(900, 620);
      const box = bareMenu();
      placeMenu(box);
      // 674 + 284 passes 900 − 12; on the left: 400 − 6 − 284.
      expect(at(flyOf(box))).toEqual(['110px', '170px']);
    });

    it('stays inside a window too narrow for either side', () => {
      current.menu.left = 100;
      stubLayout(500, 620);
      const box = bareMenu();
      placeMenu(box);
      expect(flyOf(box).style.left).toBe(`${500 - 12 - 284}px`);
    });

    it('shifts it up so it never passes the bottom of the window', () => {
      stubLayout(1000, 450);
      const box = bareMenu();
      placeMenu(box);
      expect(flyOf(box).style.top).toBe(`${450 - 12 - 330}px`);
    });

    it('keeps its top in the window when the window is shorter than it', () => {
      stubLayout(1000, 300);
      const box = bareMenu();
      placeMenu(box);
      expect(flyOf(box).style.top).toBe('12px');
    });
  });

  describe('in «Actividad»', () => {
    let win: RendererWindow | null = null;
    const PAGE = auditPage([auditEntry('a1')]);

    afterEach(() => {
      win?.close();
      win = null;
    });

    async function openRange(): Promise<RendererWindow> {
      vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
      const opened = await openActivity(PAGE);
      click(funnel('Hora'));
      click(menuButton('Rango…'));
      await opened.settle('queryMcpAudit', PAGE);
      return opened;
    }

    it('shows the picker in the flyout, not in the menu body', async () => {
      win = await openRange();
      const fly = flyOf(menu());
      expect(fly.getAttribute('role')).toBe('group');
      expect(fly.getAttribute('aria-label')).toBe('Rango de fechas');
      expect(menu().querySelectorAll('.rp')).toHaveLength(1);
      expect(menu().querySelector('.rp')?.parentElement).toBe(fly);
      // Still inside the dialog, right after the chips in the Tab order.
      const buttons = [...menu().querySelectorAll('button')].map(visible);
      const range = buttons.indexOf('Rango…');
      const from = buttons.findIndex((text) => text.startsWith('Desde'));
      expect(range).toBeLessThan(from);
      expect(from).toBeLessThan(buttons.indexOf('Quitar filtro'));
    });

    it('has the flyout only while «Rango…» is chosen in an open «Hora» menu', async () => {
      win = await openActivity(PAGE);
      click(funnel('Hora'));
      expect(menu().querySelector('.xf-fly')).toBeNull();
      click(menuButton('Rango…'));
      expect(menu().querySelector('.xf-fly')).not.toBeNull();
      click(menuButton('Hoy'));
      expect(menu().querySelector('.xf-fly')).toBeNull();
      click(menuButton('Rango…'));
      click(menuButton('Listo'));
      expect(document.querySelector('.xf-fly')).toBeNull();
      // The range stays the filter, but another column shows no flyout.
      click(funnel('Cliente'));
      expect(menu().querySelector('.xf-fly')).toBeNull();
    });

    it('stays open on clicks in the flyout and closes with a click outside both', async () => {
      win = await openRange();
      click(flyOf(menu()));
      const previous = menu().querySelector('[aria-label="Mes anterior"]');
      if (!previous) throw new Error('no «Mes anterior»');
      click(previous);
      expect(document.querySelector('.rp-month')?.textContent).toBe(
        'Octubre de 2026',
      );
      expect(openMenu()).not.toBeNull();
      expect(document.querySelector('.xf-fly')).not.toBeNull();
      click(el('mcp-activity-rows'));
      expect(openMenu()).toBeNull();
      expect(document.querySelector('.xf-fly')).toBeNull();
    });

    it('closes menu and flyout on Escape from the flyout, focus on the funnel', async () => {
      win = await openRange();
      const ahora = menuButton('Ahora');
      ahora.focus();
      ahora.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      expect(document.querySelector('.xf-fly')).toBeNull();
      expect(document.activeElement).toBe(funnel('Hora'));
    });

    it('places the flyout beside the menu and caps the menu', async () => {
      win = await openRange();
      expect(at(flyOf(menu()))).toEqual(['314px', '170px']);
      expect(menu().style.maxHeight).toBe('508px');
    });

    it('places it again after the menu is rebuilt by an answer', async () => {
      win = await openRange();
      current.filterTop = 180;
      click(menuButton('Ahora'));
      await win.settle('queryMcpAudit', PAGE);
      expect(flyOf(menu()).style.top).toBe('180px');
    });

    it('places it again when the window is resized', async () => {
      win = await openRange();
      resize(560, 400);
      // No room on the right of 308 + 6 + 284; none on the left of 40 either.
      expect(flyOf(menu()).style.left).toBe(`${560 - 12 - 284}px`);
      expect(flyOf(menu()).style.top).toBe(`${400 - 12 - 330}px`);
      expect(menu().style.maxHeight).toBe('288px');
    });

    it('caps every column menu, not only «Hora»', async () => {
      win = await openActivity(PAGE);
      click(funnel('Acción'));
      expect(menu().style.maxHeight).toBe('508px');
      resize(1000, 500);
      expect(menu().style.maxHeight).toBe('388px');
      click(menuButton('Listo'));
      // A resize with no menu open has nothing to place.
      expect(() => resize(800, 600)).not.toThrow();
    });
  });
});
