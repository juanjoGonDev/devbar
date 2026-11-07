// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  autoListWidth,
  clampListWidth,
  createGroupsSplitter,
} from '../renderer/config/groups-splitter.js';

const KEY = 'groups-list-width';

interface Fixture {
  twoPane: HTMLElement;
  pane: HTMLElement;
  handle: HTMLElement;
  listEl: HTMLElement;
}

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

function fixture(): Fixture {
  document.body.innerHTML = `
    <div id="two">
      <div id="pane"><div id="list"></div></div>
      <div id="handle" tabindex="0"></div>
    </div>`;
  const get = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  };
  return {
    twoPane: get('two'),
    pane: get('pane'),
    handle: get('handle'),
    listEl: get('list'),
  };
}

/**
 * Paints one nav row per name the way the real list does, with a laid-out
 * size: the row is 192px wide inside a 200px pane, and the name box takes
 * 100px of it, so everything else in a row (handle, icon, gaps, padding) is
 * 92px and the list's own gutter is 8px.
 */
function rows(f: Fixture, names: string[]): void {
  stubWidth(f.pane, 200, 200);
  f.listEl.innerHTML = names
    .map(
      (n) => `<div class="nav-card"><span class="nav-name">${n}</span></div>`,
    )
    .join('');
  for (const card of f.listEl.querySelectorAll('.nav-card')) {
    stubWidth(card, 192);
    const name = card.querySelector('.nav-name');
    if (name) stubWidth(name, 100);
  }
}

/** One character is 10px wide, so a name's text width is easy to predict. */
const measureText = (el: HTMLElement): number =>
  (el.textContent ?? '').length * 10;

function width(f: Fixture): number {
  return Number(f.handle.getAttribute('aria-valuenow'));
}

function key(f: Fixture, name: string): void {
  f.handle.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true }),
  );
}

function pointer(target: EventTarget, type: string, clientX: number): void {
  target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
}

describe('renderer/config/groups-splitter.ts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('clampListWidth', () => {
    it('keeps a width inside the allowed range as is', () => {
      expect(clampListWidth(200)).toBe(200);
    });

    it('never goes narrower than 140px', () => {
      expect(clampListWidth(20)).toBe(140);
    });

    it('never goes wider than 320px', () => {
      expect(clampListWidth(900)).toBe(320);
    });

    it('rounds to whole pixels', () => {
      expect(clampListWidth(200.6)).toBe(201);
    });
  });

  describe('autoListWidth', () => {
    it('fits the widest row', () => {
      expect(autoListWidth([150, 230, 180])).toBe(230);
    });

    it('clamps a very long name to the maximum', () => {
      expect(autoListWidth([500])).toBe(320);
    });

    it('falls back to the minimum with nothing to fit', () => {
      expect(autoListWidth([])).toBe(140);
    });
  });

  describe('default width', () => {
    it('fits the longest group name when the user never resized', () => {
      const f = fixture();
      rows(f, ['api', 'frontend-monorepo']);
      createGroupsSplitter({ ...f, measureText });
      // 17 chars × 10px + 92px of row chrome + 8px of list gutter.
      expect(width(f)).toBe(270);
    });

    it('follows the groups as they change', () => {
      const f = fixture();
      rows(f, ['api']);
      const splitter = createGroupsSplitter({ ...f, measureText });
      rows(f, ['a-much-longer-name']);
      splitter.refresh();
      expect(width(f)).toBe(280);
    });

    it('keeps its width while the list is not laid out', () => {
      // A hidden section measures every row at 0px; fitting to that would
      // squash the list to the minimum the next time it is shown.
      const f = fixture();
      rows(f, ['frontend-monorepo']);
      const splitter = createGroupsSplitter({ ...f, measureText });
      stubWidth(f.pane, 0, 0);
      splitter.refresh();
      expect(width(f)).toBe(270);
    });

    it('exposes the range to assistive technology', () => {
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      expect(f.handle.getAttribute('aria-valuemin')).toBe('140');
      expect(f.handle.getAttribute('aria-valuemax')).toBe('320');
    });

    it('drives the pane width through a custom property', () => {
      const f = fixture();
      rows(f, ['frontend-monorepo']);
      createGroupsSplitter({ ...f, measureText });
      expect(f.twoPane.style.getPropertyValue('--groups-list-width')).toBe(
        '270px',
      );
    });
  });

  describe('a width the user chose', () => {
    it('reopens at the stored width', () => {
      localStorage.setItem(KEY, '250');
      const f = fixture();
      rows(f, ['api']);
      createGroupsSplitter({ ...f, measureText });
      expect(width(f)).toBe(250);
    });

    it('clamps a stored width that is out of range', () => {
      localStorage.setItem(KEY, '9999');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      expect(width(f)).toBe(320);
    });

    it('ignores a stored value that is not a number', () => {
      localStorage.setItem(KEY, 'wide');
      const f = fixture();
      rows(f, ['frontend-monorepo']);
      createGroupsSplitter({ ...f, measureText });
      expect(width(f)).toBe(270);
    });

    it('stops following the groups once the user resized', () => {
      const f = fixture();
      rows(f, ['api']);
      const splitter = createGroupsSplitter({ ...f, measureText });
      key(f, 'ArrowRight');
      const chosen = width(f);
      rows(f, ['a-much-longer-name']);
      splitter.refresh();
      expect(width(f)).toBe(chosen);
    });
  });

  describe('keyboard', () => {
    it('widens by 16px on ArrowRight and remembers it', () => {
      localStorage.setItem(KEY, '200');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      key(f, 'ArrowRight');
      expect(width(f)).toBe(216);
      expect(localStorage.getItem(KEY)).toBe('216');
    });

    it('narrows by 16px on ArrowLeft', () => {
      localStorage.setItem(KEY, '200');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      key(f, 'ArrowLeft');
      expect(width(f)).toBe(184);
    });

    it('stops at the minimum', () => {
      localStorage.setItem(KEY, '150');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      key(f, 'ArrowLeft');
      expect(width(f)).toBe(140);
    });

    it('ignores every other key', () => {
      localStorage.setItem(KEY, '200');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      key(f, 'Enter');
      expect(width(f)).toBe(200);
    });
  });

  describe('dragging', () => {
    it('follows the pointer and remembers where it was dropped', () => {
      localStorage.setItem(KEY, '200');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      pointer(f.handle, 'pointerdown', 300);
      pointer(window, 'pointermove', 340);
      expect(width(f)).toBe(240);
      expect(f.twoPane.classList.contains('is-resizing')).toBe(true);
      pointer(window, 'pointerup', 340);
      expect(localStorage.getItem(KEY)).toBe('240');
      expect(f.twoPane.classList.contains('is-resizing')).toBe(false);
    });

    it('clamps the drag to the allowed range', () => {
      localStorage.setItem(KEY, '200');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      pointer(f.handle, 'pointerdown', 300);
      pointer(window, 'pointermove', 900);
      expect(width(f)).toBe(320);
    });

    it('stops following the pointer once it is released', () => {
      localStorage.setItem(KEY, '200');
      const f = fixture();
      createGroupsSplitter({ ...f, measureText });
      pointer(f.handle, 'pointerdown', 300);
      pointer(window, 'pointerup', 300);
      pointer(window, 'pointermove', 360);
      expect(width(f)).toBe(200);
    });

    it('stores nothing for a click that never moved', () => {
      const f = fixture();
      rows(f, ['api']);
      createGroupsSplitter({ ...f, measureText });
      pointer(f.handle, 'pointerdown', 300);
      pointer(window, 'pointerup', 300);
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });

  describe('resetting', () => {
    it('goes back to the auto width on double-click and forgets the choice', () => {
      localStorage.setItem(KEY, '300');
      const f = fixture();
      rows(f, ['frontend-monorepo']);
      createGroupsSplitter({ ...f, measureText });
      f.handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(width(f)).toBe(270);
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });

  describe('storage', () => {
    it('still resizes when the browser refuses local storage', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const f = fixture();
      rows(f, ['frontend-monorepo']);
      createGroupsSplitter({ ...f, measureText });
      key(f, 'ArrowRight');
      expect(width(f)).toBe(286);
      f.handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(width(f)).toBe(270);
    });
  });
});
