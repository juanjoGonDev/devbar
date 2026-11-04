// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createResizablePane,
  fitWidth,
  type ResizablePaneOptions,
} from '../renderer/resizable-pane.js';

const KEY = 'test-list-width';

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
 * A pane of nested rows, the way the logs sidebar nests them: a row is
 * 192px wide inside a 200px pane, and its name box takes 100px of it, so
 * the row's own chrome is 92px and the pane's gutter 8px.
 */
function mount(names: string[]): Omit<ResizablePaneOptions, 'measureText'> {
  document.body.innerHTML = `
    <div id="host">
      <div id="pane"><div id="list">${names
        .map(
          (n) =>
            `<section><div class="row"><span class="name">${n}</span></div></section>`,
        )
        .join('')}</div></div>
      <div id="handle" tabindex="0"></div>
    </div>`;
  const pane = get('pane');
  stubWidth(pane, 200, 200);
  for (const row of pane.querySelectorAll('.row')) {
    stubWidth(row, 192);
    const name = row.querySelector('.name');
    if (name) stubWidth(name, 100);
  }
  return {
    host: get('host'),
    pane,
    handle: get('handle'),
    listEl: get('list'),
    min: 100,
    max: 300,
    fallback: 150,
    storageKey: KEY,
    cssVar: '--test-list-width',
    rowSelector: '.row',
    nameSelector: '.name',
  };
}

const measureText = (el: HTMLElement): number =>
  (el.textContent ?? '').length * 10;

function width(options: Pick<ResizablePaneOptions, 'handle'>): number {
  return Number(options.handle.getAttribute('aria-valuenow'));
}

describe('renderer/resizable-pane.ts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fitWidth', () => {
    it('fits the widest row inside the range', () => {
      expect(fitWidth([120, 180], { min: 100, max: 300 })).toBe(180);
    });

    it('falls back to the minimum with nothing to fit', () => {
      expect(fitWidth([], { min: 100, max: 300 })).toBe(100);
    });

    it('clamps to the maximum', () => {
      expect(fitWidth([900], { min: 100, max: 300 })).toBe(300);
    });
  });

  describe('createResizablePane', () => {
    it('drives its own custom property and range', () => {
      const options = mount(['abcdefghij']);
      createResizablePane({ ...options, measureText });
      // 10 chars × 10px + 92px of chrome + 8px of gutter.
      expect(options.host.style.getPropertyValue('--test-list-width')).toBe(
        '200px',
      );
      expect(options.handle.getAttribute('aria-valuemin')).toBe('100');
      expect(options.handle.getAttribute('aria-valuemax')).toBe('300');
    });

    it('starts at the fallback width while nothing is laid out', () => {
      const options = mount(['abcdefghij']);
      stubWidth(options.pane, 0, 0);
      createResizablePane({ ...options, measureText });
      expect(width(options)).toBe(150);
    });

    it('fits only the rows on screen, skipping the hidden ones', () => {
      const options = mount(['abc', 'a-very-long-hidden-name']);
      const hidden = options.listEl.querySelectorAll('.row')[1];
      if (hidden) stubWidth(hidden, 0);
      createResizablePane({ ...options, measureText });
      expect(width(options)).toBe(130);
    });

    it('keeps its width when no row is laid out at all', () => {
      const options = mount(['abcdefghij']);
      const pane = createResizablePane({ ...options, measureText });
      for (const row of options.listEl.querySelectorAll('.row'))
        stubWidth(row, 0);
      pane.refresh();
      expect(width(options)).toBe(200);
    });

    it('persists a chosen width under its own key', () => {
      const options = mount(['abc']);
      createResizablePane({ ...options, measureText });
      options.handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      expect(localStorage.getItem(KEY)).toBe('146');
    });

    it('measures a name in the weight it is asked to, with its spacing and case', () => {
      const options = mount(['abc']);
      const name = options.listEl.querySelector<HTMLElement>('.name');
      if (name) {
        name.style.letterSpacing = '2px';
        name.style.textTransform = 'uppercase';
      }
      const probed: CSSStyleDeclaration[] = [];
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
        function (this: HTMLElement) {
          if (this.parentElement === document.body && this.tagName === 'SPAN') {
            probed.push(this.style);
            return 40;
          }
          return this.id === 'pane' ? 200 : this.matches('.row') ? 192 : 100;
        },
      );
      createResizablePane({ ...options, nameWeight: '600' });
      expect(probed[0]?.fontWeight).toBe('600');
      expect(probed[0]?.letterSpacing).toBe('2px');
      expect(probed[0]?.textTransform).toBe('uppercase');
      // 40px of text + 92px of chrome + 8px of gutter.
      expect(width(options)).toBe(140);
      expect(document.body.querySelectorAll(':scope > span')).toHaveLength(0);
    });
  });
});
