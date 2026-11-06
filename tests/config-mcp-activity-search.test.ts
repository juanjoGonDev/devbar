// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { iconText } from './helpers/icon-text.js';
import { auditEntry, click, el, visible } from './helpers/mcp.js';
import { tipOf } from './helpers/tip.js';
import {
  activeLine,
  auditPage,
  checkbox,
  funnel,
  lastQuery,
  menuButton,
  openActivity,
  row,
  sortButton,
  summaryDetails,
  summaryPill,
  toggle,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import {
  createActivitySearch,
  SEARCH_DELAY_MS,
} from '../renderer/config/mcp-activity-search.js';

/**
 * Searching «Actividad» (renderer/config/mcp-activity-search.ts): the field
 * waits for the typing to pause, marks what it matched in the rows, and
 * ⌘F reaches it; plus the summary beside it and its «Quitar filtros y orden».
 */

const READ = auditEntry('a1', {
  tool: 'search_logs',
  target: 'Back › Normal',
  summary: '12 líneas en back',
});

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input'));
}
function enter(input: HTMLInputElement): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
}
function accelF(meta: boolean): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    metaKey: meta,
    ctrlKey: !meta,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe('renderer/config/mcp-activity-search.ts', () => {
  describe('on its own', () => {
    let input: HTMLInputElement;
    let clear: HTMLButtonElement;
    let shortcut: HTMLElement;
    let applied: string[];

    function mount(platform = 'darwin', shown = true) {
      document.body.innerHTML =
        '<input id="q" type="search"><button id="x"></button><kbd id="k"></kbd>';
      input = el<HTMLInputElement>('q');
      clear = el<HTMLButtonElement>('x');
      shortcut = el('k');
      applied = [];
      return createActivitySearch(
        { input, clear, shortcut },
        { platform, shown: () => shown, apply: (text) => applied.push(text) },
      );
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies the text once the typing pauses', () => {
      mount();
      type(input, 'res');
      vi.advanceTimersByTime(SEARCH_DELAY_MS - 1);
      type(input, 'restart');
      vi.advanceTimersByTime(SEARCH_DELAY_MS - 1);
      expect(applied).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(applied).toEqual(['restart']);
    });

    it('applies at once on Enter, and not twice', () => {
      mount();
      type(input, 'logs');
      enter(input);
      expect(applied).toEqual(['logs']);
      vi.advanceTimersByTime(SEARCH_DELAY_MS);
      expect(applied).toEqual(['logs']);
    });

    it('swaps the shortcut for ✕ while there is text, and ✕ empties it', () => {
      mount();
      expect(iconText(shortcut)).toBe('[command]F');
      expect(clear.hidden).toBe(true);
      type(input, 'x');
      expect(clear.hidden).toBe(false);
      expect(shortcut.hidden).toBe(true);
      enter(input);
      click(clear);
      expect(input.value).toBe('');
      expect(applied).toEqual(['x', '']);
      expect(document.activeElement).toBe(input);
      expect(clear.hidden).toBe(true);
    });

    it('spells the shortcut Ctrl+F off the Mac', () => {
      mount('linux');
      expect(shortcut.textContent).toBe('Ctrl+F');
    });

    it('takes ⌘F only while the log is on screen', () => {
      mount('darwin', true);
      expect(accelF(true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input);
      input.blur();
      mount('darwin', false);
      accelF(true);
      expect(document.activeElement).not.toBe(input);
    });
  });

  describe('in the window', () => {
    let win: RendererWindow | null = null;
    const search = (): HTMLInputElement =>
      el<HTMLInputElement>('mcp-activity-search');

    afterEach(() => {
      win?.close();
      win = null;
    });

    it('asks main for the text and marks it in the rows', async () => {
      win = await openActivity([READ]);
      type(search(), 'Back');
      enter(search());
      expect(lastQuery(win).search).toBe('Back');
      expect(lastQuery(win).offset).toBe(0);
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 9 }));
      const marks = [...row('a1').querySelectorAll('mark')].map(
        (m) => m.textContent,
      );
      expect(marks).toEqual(['Back', 'back']);
      expect(visible(row('a1').querySelector('.mcp-entry-action'))).toBe(
        'search_logs · Back › Normal · 12 líneas en back',
      );
      expect(activeLine()).toBe('1 de 9');
      expect(summaryPill()).toBeNull();
    });

    it('takes ⌘F while «Actividad» is the section on screen', async () => {
      win = await openActivity([READ]);
      accelF(false);
      expect(document.activeElement).not.toBe(search());
      click(document.querySelector('[data-target="mcp"]'));
      accelF(false);
      expect(document.activeElement).toBe(search());
    });

    it('counts the filters and the sort in one pill, spelled out in its tooltip', async () => {
      win = await openActivity(auditPage([READ], { retained: 4 }));
      click(sortButton('Cliente'));
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      click(funnel('Resultado'));
      toggle(checkbox('Error'));
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      expect(iconText(el('mcp-activity-active'))).toBe(
        '1 de 4[filter]1 filtro · orden[x]',
      );
      click(funnel('Hora'));
      click(menuButton('Hoy'));
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      expect(visible(summaryPill())).toBe('2 filtros · orden');
      expect(summaryDetails()).toEqual([
        'Hora: Hoy',
        'Resultado: Correcto, Con avisos, Rechazado, Pendiente',
        'Orden: Cliente (A → Z)',
      ]);
      expect(el('mcp-activity-active').getAttribute('aria-live')).toBe(
        'polite',
      );
    });

    it('takes every filter and the sort off with ✕, but keeps the search', async () => {
      win = await openActivity(auditPage([READ], { retained: 4 }));
      click(sortButton('Cliente'));
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      click(funnel('Resultado'));
      toggle(checkbox('Error'));
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      type(search(), 'logs');
      enter(search());
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      const clear = el('mcp-activity-active').querySelector(
        'button[aria-label="Quitar filtros y orden"]',
      );
      expect(tipOf(clear)).toBe('Quitar filtros y orden');
      click(clear);
      expect(lastQuery(win)).toEqual({
        offset: 0,
        limit: 50,
        sort: [{ key: 'time', dir: 'desc' }],
        search: 'logs',
      });
      expect(search().value).toBe('logs');
      await win.settle('queryMcpAudit', auditPage([READ], { retained: 4 }));
      expect(activeLine()).toBe('1 de 4');
      expect(summaryPill()).toBeNull();
    });

    it('says how many calls it keeps with nothing applied', async () => {
      win = await openActivity(auditPage([READ], { retained: 4 }));
      expect(activeLine()).toBe('4 llamadas · 30 días');
    });
  });
});
