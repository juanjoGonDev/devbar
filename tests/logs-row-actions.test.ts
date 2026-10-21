// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, type LogsDom } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';

/**
 * `renderer/logs/row-actions.ts` is the small toolbar that floats over the
 * row under the pointer: copy the line, silence lines like it, filter by it.
 * ONE toolbar moves between rows, so drawing 600 rows does not mean building
 * 1 800 buttons.
 */
type ActionsModule = typeof import('../renderer/logs/row-actions.js');
type PaneModule = typeof import('../renderer/logs/pane.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

describe('renderer/logs/row-actions.ts', () => {
  let dom: LogsDom;
  let actions: ActionsModule;
  let pane: PaneModule;
  let elements: ElementsModule;
  let view: ViewModule;
  let prefilled: unknown[];
  let copied: string[];

  beforeEach(async () => {
    dom = mountLogsDom({
      api: {
        buildSilencePattern: (text: string) => `re:${text}`,
        removeSilencePattern: () => Promise.resolve({ ok: true }),
      },
    });
    copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    pane = await import('../renderer/logs/pane.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
    actions = await import('../renderer/logs/row-actions.js');
    prefilled = [];
    view.installSilenceHooks({
      prefill: (level, pattern) => prefilled.push([level, pattern]),
    });
    view.view.currentGroupId = 'g1';
    view.view.currentCommandId = 'c1';
  });

  /** Draw these lines and hover the row holding `text`. */
  function hover(lines: LogEntry[], text: string): HTMLElement {
    pane.resetBuffer(lines);
    const row = Array.from(
      elements.linesEl.querySelectorAll<HTMLElement>('.line'),
    ).find((el) => el.dataset.line === text);
    if (!row) throw new Error(`no row for ${text}`);
    row
      .querySelector('.body')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return row;
  }

  function button(row: HTMLElement, label: string): HTMLButtonElement | null {
    return row.querySelector<HTMLButtonElement>(
      `.row-actions button[aria-label="${label}"]`,
    );
  }

  describe('the toolbar', () => {
    it('appears on the row under the pointer, and only there', () => {
      const row = hover([entry('uno'), entry('dos')], 'dos');
      expect(elements.linesEl.querySelectorAll('.row-actions')).toHaveLength(1);
      expect(row.querySelector('.row-actions')).not.toBeNull();
    });

    it('moves to the next row hovered instead of multiplying', () => {
      hover([entry('uno'), entry('dos')], 'uno');
      const second = elements.linesEl.querySelector<HTMLElement>(
        '.line[data-line="dos"]',
      );
      second?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(elements.linesEl.querySelectorAll('.row-actions')).toHaveLength(1);
      expect(second?.querySelector('.row-actions')).not.toBeNull();
    });

    it('goes away when the pointer leaves the list', () => {
      hover([entry('uno')], 'uno');
      elements.linesEl.dispatchEvent(new MouseEvent('mouseleave'));
      expect(elements.linesEl.querySelector('.row-actions')).toBeNull();
    });

    it('replaces the old always-visible silence icon on every row', () => {
      pane.resetBuffer([
        entry('ojo', { originalLevel: 'warn', level: 'warn' }),
      ]);
      expect(elements.linesEl.querySelector('.silence-btn')).toBeNull();
    });

    it('does not select the row when one of its buttons is pressed', () => {
      const row = hover([entry('uno')], 'uno');
      const event = new MouseEvent('click', { bubbles: true });
      const stop = vi.spyOn(event, 'stopPropagation');
      button(row, 'Copiar línea')?.dispatchEvent(event);
      expect(stop).toHaveBeenCalled();
    });
  });

  describe('Copiar línea', () => {
    it('copies the line as it was printed, without its colours', async () => {
      const row = hover(
        [entry('\u001b[31m{"a":1}\u001b[0m')],
        '\u001b[31m{"a":1}\u001b[0m',
      );
      button(row, 'Copiar línea')?.click();
      await Promise.resolve();
      expect(copied).toEqual(['{"a":1}']);
    });
  });

  describe('Filtrar por esto', () => {
    it('searches for the text selected inside the row', () => {
      const row = hover([entry('GET /api/users 200')], 'GET /api/users 200');
      const text = row.querySelector('.body')?.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 14);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      button(row, 'Filtrar por esto')?.click();
      expect(elements.filterEl.value).toBe('/api/users');
      window.getSelection()?.removeAllRanges();
    });

    it('falls back to the most telling token of the line, and filters', () => {
      const row = hover(
        [entry('(node:28634) DeprecationWarning: punycode'), entry('otra')],
        '(node:28634) DeprecationWarning: punycode',
      );
      button(row, 'Filtrar por esto')?.click();
      expect(elements.filterEl.value).toBe('DeprecationWarning');
      expect(
        Array.from(
          elements.linesEl.querySelectorAll<HTMLElement>('.line'),
          (el) => el.dataset.line,
        ),
      ).toEqual(['(node:28634) DeprecationWarning: punycode']);
    });

    it.each([
      ['Error: socket hang up', 'socket'],
      ['GET /api/health 200 3ms', '/api/health'],
      ['[Nest] 42 - 10/10/2026 LOG [RouterExplorer] Mapped', 'RouterExplorer'],
      ['42 17', ''],
    ])('picks %j → %j', (line, token) => {
      expect(actions.filterTokenFor(line)).toBe(token);
    });
  });

  describe('Silenciar', () => {
    it('is offered on a warning', () => {
      const row = hover([entry('ojo', { originalLevel: 'warn' })], 'ojo');
      expect(button(row, 'Silenciar líneas como esta…')?.hidden).toBe(false);
    });

    it('stays away from a line with no severity to silence', () => {
      const row = hover([entry('rutina')], 'rutina');
      expect(button(row, 'Silenciar líneas como esta…')?.hidden).toBe(true);
    });

    it('stays away when no single command owns the view', () => {
      view.view.currentCommandId = null;
      const row = hover([entry('ojo', { originalLevel: 'warn' })], 'ojo');
      expect(button(row, 'Silenciar líneas como esta…')?.hidden).toBe(true);
    });

    it('prefills the silenced popover with the built pattern instead of saving it', () => {
      const text = '\u001b[33mfallo 42\u001b[0m  ';
      const row = hover([entry(text, { originalLevel: 'warn' })], text);
      button(row, 'Silenciar líneas como esta…')?.click();
      expect(dom.argsFor('buildSilencePattern')).toEqual([['fallo 42']]);
      expect(prefilled).toEqual([['warn', 're:fallo 42']]);
      expect(dom.argsFor('addSilencePattern')).toEqual([]);
    });

    it('offers to UNDO it on a line a rule already swallowed', async () => {
      const row = hover(
        [entry('fallo 42', { originalLevel: 'warn', silenced: true })],
        'fallo 42',
      );
      const undo = button(row, 'Quitar silencio (esta línea)');
      expect(undo?.hidden).toBe(false);
      undo?.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(dom.argsFor('removeSilencePattern')).toEqual([
        ['g1', 'c1', 'warn', 're:fallo 42'],
        ['g1', 'c1', 'warn', 'fallo 42'],
      ]);
    });

    it('keeps the silenced popover open, since it is about to fill it', async () => {
      const popover = await import('../renderer/logs/silence-popover.js');
      popover.setSilencePopover(true);
      const row = hover([entry('ojo', { originalLevel: 'warn' })], 'ojo');
      button(row, 'Silenciar líneas como esta…')?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
      expect(elements.popoverEl.hidden).toBe(false);
    });
  });
});
