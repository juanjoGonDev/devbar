// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  byId,
  startLinked,
  tabButton,
  tap,
  tapId,
  text,
  visibleTab,
} from './helpers/remote-page.js';

/**
 * How a linked phone moves between screens: a header with the screen's
 * title, the menu button on the left and the bell on the right, and a side
 * menu that slides in from the left — by the button or by a swipe from the
 * edge of the screen.
 */

const SCREEN_KEY = 'devbar-remote:screen';

const menuButton = () => byId<HTMLButtonElement>('menu-button');
const isOpen = () => menuButton().getAttribute('aria-expanded') === 'true';
const drawerItem = (tab: string) =>
  byId('drawer').querySelector<HTMLButtonElement>(`[data-tab-button="${tab}"]`);

function pointer(
  type: string,
  x: number,
  y = 400,
  target: EventTarget = byId('panel-main'),
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
    }),
  );
}

function key(name: string, shiftKey = false): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }),
  );
}

describe('renderer/remote/drawer.ts', () => {
  describe('the header', () => {
    it('titles the screen and starts on «Grupos» with the menu closed', async () => {
      await startLinked();

      expect(visibleTab()).toBe('groups');
      expect(text('screen-title')).toBe('Grupos');
      expect(isOpen()).toBe(false);
      expect(menuButton().getAttribute('aria-controls')).toBe('drawer');
    });

    it('opens «Avisos» from the bell, which the menu does not list', async () => {
      await startLinked();

      tapId('notices-tab');

      expect(visibleTab()).toBe('notices');
      expect(text('screen-title')).toBe('Avisos');
      expect(drawerItem('notices')).toBeNull();
    });
  });

  describe('the side menu', () => {
    it('opens from the menu button, moving focus into it', async () => {
      await startLinked();

      tap(menuButton());

      expect(isOpen()).toBe(true);
      expect(document.activeElement).toBe(drawerItem('groups'));
      expect(drawerItem('groups')?.getAttribute('aria-current')).toBe('page');
      expect(byId('panel-main').hasAttribute('inert')).toBe(true);
      expect(byId('panel-main').getAttribute('aria-hidden')).toBe('true');
    });

    it('names the computer and counts its groups', async () => {
      await startLinked();

      expect(text('drawer-host')).toBe('Mac-de-Ana');
      expect(text('drawer-count-groups')).toBe('2');
    });

    it('navigates and closes when an item is picked, focus back on the menu button', async () => {
      await startLinked();
      tap(menuButton());

      tap(drawerItem('logs'));

      expect(visibleTab()).toBe('logs');
      expect(text('screen-title')).toBe('Logs');
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(menuButton());
      expect(byId('panel-main').hasAttribute('inert')).toBe(false);
      expect(drawerItem('logs')?.getAttribute('aria-current')).toBe('page');
      expect(drawerItem('groups')?.hasAttribute('aria-current')).toBe(false);
    });

    it('closes from the dimmed backdrop and from Escape', async () => {
      await startLinked();
      tap(menuButton());

      tapId('drawer-backdrop');
      expect(isOpen()).toBe(false);

      tap(menuButton());
      key('Escape');
      expect(isOpen()).toBe(false);
      expect(visibleTab()).toBe('groups');
    });

    it('keeps the keyboard inside while open', async () => {
      await startLinked();
      tap(menuButton());
      const items = [
        ...byId('drawer').querySelectorAll<HTMLButtonElement>('button'),
      ];
      const first = items[0];
      const last = items.at(-1);

      last?.focus();
      key('Tab');
      expect(document.activeElement).toBe(first);
      key('Tab', true);
      expect(document.activeElement).toBe(last);
    });
  });

  describe('the edge swipe', () => {
    it('follows a drag from the left edge and opens past 40%', async () => {
      const h = await startLinked();

      pointer('pointerdown', 6);
      h.advance(50);
      pointer('pointermove', 40);
      expect(byId('linked-panel').dataset.drawer).toBe('dragging');
      h.advance(400);
      pointer('pointermove', 160);
      h.advance(400);
      pointer('pointerup', 160);

      expect(isOpen()).toBe(true);
    });

    it('snaps back when let go short of it', async () => {
      const h = await startLinked();

      pointer('pointerdown', 6);
      h.advance(50);
      pointer('pointermove', 40);
      h.advance(400);
      pointer('pointermove', 70);
      h.advance(400);
      pointer('pointerup', 70);

      expect(isOpen()).toBe(false);
      expect(byId('linked-panel').dataset.drawer).toBe('closed');
    });

    it('ignores a drag that starts away from the edge, or a vertical one', async () => {
      const h = await startLinked();

      pointer('pointerdown', 120);
      h.advance(400);
      pointer('pointermove', 300);
      pointer('pointerup', 300);
      pointer('pointerdown', 6, 400);
      h.advance(400);
      pointer('pointermove', 12, 600);
      pointer('pointerup', 12, 600);

      expect(isOpen()).toBe(false);
    });

    it('closes the open menu when dragged back to the left', async () => {
      const h = await startLinked();
      tap(menuButton());

      pointer('pointerdown', 260, 400, byId('drawer'));
      h.advance(50);
      pointer('pointermove', 230, 400, byId('drawer'));
      h.advance(400);
      pointer('pointermove', 100, 400, byId('drawer'));
      h.advance(400);
      pointer('pointerup', 100, 400, byId('drawer'));

      expect(isOpen()).toBe(false);
    });
  });

  describe('the last screen', () => {
    it('comes back on the next visit', async () => {
      const storage = new Map<string, string>();
      await startLinked(undefined, { storage });
      tap(tabButton('settings'));
      expect(storage.get(SCREEN_KEY)).toBe('settings');

      await startLinked(undefined, { storage });

      expect(visibleTab()).toBe('settings');
      expect(text('screen-title')).toBe('Ajustes');
    });

    it('ignores a stored screen it does not know', async () => {
      const storage = new Map([[SCREEN_KEY, 'nope']]);

      await startLinked(undefined, { storage });

      expect(visibleTab()).toBe('groups');
    });

    it('still navigates when the browser refuses storage', async () => {
      await startLinked(undefined, { storage: 'broken' });

      tap(tabButton('logs'));

      expect(visibleTab()).toBe('logs');
    });
  });
});
