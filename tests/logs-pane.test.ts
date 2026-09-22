// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom, scrolledIntoView } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';

/**
 * `renderer/logs/pane.ts` owns everything the log list puts on screen: which
 * slice of the buffer is drawn, what the counts say, where an arriving line
 * goes, and when the reader is allowed to be yanked to the tail.
 *
 * jsdom does no layout, so the scroll geometry is stubbed explicitly per test
 * (see `stubScroll`) rather than left at the zeros a layout-less document
 * reports — otherwise every test would silently run the "already at the
 * bottom" branch and the rest would never execute.
 */
type PaneModule = typeof import('../renderer/logs/pane.js');
type BufferModule = typeof import('../renderer/logs/buffer.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type ViewModule = typeof import('../renderer/logs/view.js');

function lines(count: number, prefix = 'line'): LogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry(`${prefix} ${i}`, { ts: i }),
  );
}

describe('renderer/logs/pane.ts', () => {
  let pane: PaneModule;
  let buffer: BufferModule;
  let elements: ElementsModule;
  let view: ViewModule;

  beforeEach(async () => {
    vi.useFakeTimers();
    mountLogsDom();
    pane = await import('../renderer/logs/pane.js');
    buffer = await import('../renderer/logs/buffer.js');
    elements = await import('../renderer/logs/elements.js');
    view = await import('../renderer/logs/view.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** jsdom reports every box as 0×0; give the scroller a real geometry. */
  function stubScroll(
    geometry: {
      scrollTop?: number;
      scrollHeight?: number;
      clientHeight?: number;
    } = {},
  ): void {
    const main = elements.mainEl;
    Object.defineProperty(main, 'scrollTop', {
      configurable: true,
      writable: true,
      value: geometry.scrollTop ?? 0,
    });
    Object.defineProperty(main, 'scrollHeight', {
      configurable: true,
      writable: true,
      value: geometry.scrollHeight ?? 0,
    });
    Object.defineProperty(main, 'clientHeight', {
      configurable: true,
      writable: true,
      value: geometry.clientHeight ?? 0,
    });
  }

  function drawnRows(): HTMLElement[] {
    return Array.from(elements.linesEl.children) as HTMLElement[];
  }

  function drawnText(): string[] {
    return drawnRows().map((row) => row.dataset.line ?? '');
  }

  describe('the counts strip', () => {
    it('says how many lines there are when nothing is hidden', () => {
      pane.resetBuffer(lines(3));
      expect(elements.countsEl.textContent).toBe('3 líneas');
    });

    it('says how many of how many once a filter narrows it', () => {
      pane.resetBuffer([entry('api ok'), entry('web ok'), entry('api mal')]);
      elements.filterEl.value = 'api';
      pane.applyFilter();
      expect(elements.countsEl.textContent).toBe('2 de 3 líneas');
    });
  });

  describe('applyFilter', () => {
    it('redraws the list from the whole buffer, not from what is on screen', () => {
      pane.resetBuffer([entry('uno'), entry('dos'), entry('tres')]);
      elements.filterEl.value = 'os$';
      pane.applyFilter();
      expect(drawnText()).toEqual(['dos']);
    });

    it('treats a half-typed regex as literal text instead of failing', () => {
      pane.resetBuffer([entry('a[b'), entry('otra')]);
      elements.filterEl.value = 'a[';
      pane.applyFilter();
      expect(drawnText()).toEqual(['a[b']);
    });

    it('runs on every keystroke in the filter box', () => {
      pane.resetBuffer([entry('uno'), entry('dos')]);
      elements.filterEl.value = 'uno';
      elements.filterEl.dispatchEvent(new Event('input'));
      expect(drawnText()).toEqual(['uno']);
    });

    it('searches the text, not the ANSI escapes wrapped around it', () => {
      pane.resetBuffer([entry('[31mrojo[0m'), entry('azul')]);
      elements.filterEl.value = 'rojo';
      pane.applyFilter();
      expect(drawnText()).toEqual(['[31mrojo[0m']);
    });
  });

  describe('the level pin', () => {
    it('shows the escape hatch, named after what it is hiding', () => {
      pane.setLevelFilter(['warn']);
      expect(elements.levelPillEl.hidden).toBe(false);
      expect(elements.levelPillTextEl.textContent).toBe('sólo ⚠ warnings');
      expect(elements.levelPillEl.className).toBe('level-pill warn');
    });

    it('lets errors outrank warnings when it stands for both', () => {
      pane.setLevelFilter(['warn', 'error']);
      expect(elements.levelPillTextEl.textContent).toBe(
        'sólo ⚠ warnings + ⛔ errores',
      );
      expect(elements.levelPillEl.className).toBe('level-pill err');
    });

    it('hides the pill when nothing is pinned', () => {
      pane.setLevelFilter(['warn']);
      pane.setLevelFilter([]);
      expect(elements.levelPillEl.hidden).toBe(true);
    });

    it('keeps only the lines of the pinned level', () => {
      pane.resetBuffer([
        entry('normal'),
        entry('ojo', { originalLevel: 'warn' }),
        entry('fallo', { originalLevel: 'error' }),
      ]);
      pane.setLevelFilter(['error']);
      expect(drawnText()).toEqual(['fallo']);
    });

    it('pressing the pill drops the pin and brings everything back', () => {
      pane.resetBuffer([
        entry('normal'),
        entry('ojo', { originalLevel: 'warn' }),
      ]);
      pane.setLevelFilter(['warn']);
      elements.levelPillEl.click();
      expect(elements.levelPillEl.hidden).toBe(true);
      expect(drawnText()).toEqual(['normal', 'ojo']);
    });
  });

  describe('the drawn window', () => {
    it('draws only the tail of a buffer bigger than the DOM budget', () => {
      pane.resetBuffer(lines(1000));
      expect(drawnRows()).toHaveLength(600);
      expect(drawnText()[0]).toBe('line 400');
      expect(drawnText().at(-1)).toBe('line 999');
    });

    it('approaching the top extends the window upward', () => {
      pane.resetBuffer(lines(1000));
      stubScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
      elements.mainEl.dispatchEvent(new Event('scroll'));
      expect(buffer.buffer.winStart).toBe(100);
      expect(drawnText()[0]).toBe('line 100');
    });

    it('holds the viewport still while it grows upward', () => {
      pane.resetBuffer(lines(1000));
      stubScroll({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
      // The taller content is measured, not computed: rows wrap, so the delta
      // is the only honest answer. Growing by 1200px must push scrollTop by
      // exactly that much or the reader's line jumps away under them.
      Object.defineProperty(elements.mainEl, 'scrollHeight', {
        configurable: true,
        get: () => (buffer.buffer.winStart === 0 ? 2200 : 1000),
      });
      elements.mainEl.dispatchEvent(new Event('scroll'));
      expect(elements.mainEl.scrollTop).toBe(0);
      // A second pass reaches the top, where the measured delta applies.
      elements.mainEl.dispatchEvent(new Event('scroll'));
      expect(buffer.buffer.winStart).toBe(0);
      expect(elements.mainEl.scrollTop).toBe(1200);
    });

    it('approaching the bottom extends the window downward', () => {
      pane.resetBuffer(lines(1000));
      buffer.buffer.winStart = 0;
      buffer.buffer.winEnd = 100;
      stubScroll({ scrollTop: 600, scrollHeight: 700, clientHeight: 100 });
      elements.mainEl.dispatchEvent(new Event('scroll'));
      expect(buffer.buffer.winEnd).toBe(400);
    });

    it('does not grow past the top when it is already there', () => {
      pane.resetBuffer(lines(10));
      stubScroll({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
      elements.mainEl.dispatchEvent(new Event('scroll'));
      expect(buffer.buffer.winStart).toBe(0);
      expect(drawnRows()).toHaveLength(10);
    });
  });

  describe('a line that just arrived', () => {
    it('appends a row and keeps the counts honest', () => {
      pane.resetBuffer(lines(2));
      pane.pushEntry(entry('nueva'));
      expect(drawnText().at(-1)).toBe('nueva');
      expect(elements.countsEl.textContent).toBe('3 líneas');
    });

    it('stays out of the DOM when the filter does not want it', () => {
      pane.resetBuffer([entry('api')]);
      elements.filterEl.value = 'api';
      pane.applyFilter();
      pane.pushEntry(entry('web'));
      expect(drawnText()).toEqual(['api']);
      expect(elements.countsEl.textContent).toBe('1 de 2 líneas');
    });

    it('never yanks a reader who has lines selected', () => {
      // A selection detaches the view from the tail: the lines still pile up
      // in the buffer, but the drawn window stops following them.
      pane.resetBuffer(lines(2));
      buffer.buffer.selected.add(0);
      pane.pushEntry(entry('nueva'));
      expect(drawnText()).toEqual(['line 0', 'line 1']);
      expect(buffer.buffer.entries).toHaveLength(3);
      expect(buffer.buffer.visible).toHaveLength(3);
    });

    it('never yanks a reader scrolled back into history', () => {
      pane.resetBuffer(lines(10));
      buffer.buffer.winEnd = 4;
      pane.pushEntry(entry('nueva'));
      expect(drawnText().at(-1)).toBe('line 9');
      expect(elements.countsEl.textContent).toBe('11 líneas');
    });

    it('drops rows off the top once the DOM budget is spent', () => {
      pane.resetBuffer(lines(900));
      expect(drawnRows()).toHaveLength(600);
      for (let i = 0; i < 301; i += 1) pane.pushEntry(entry(`extra ${i}`));
      expect(drawnRows()).toHaveLength(900);
      pane.pushEntry(entry('la que desborda'));
      expect(drawnRows()).toHaveLength(900);
      expect(drawnText().at(-1)).toBe('la que desborda');
    });

    it('does not draw the same line twice when it is the one that forces a trim', () => {
      // A trim rebuilds `visible` and the window from scratch, this entry
      // included: carrying on would append a second row for it, one duplicate
      // per trim for the life of the view.
      // The trim only fires once memory is a whole edge chunk past its cap.
      view.view.memoryCap = 5;
      pane.resetBuffer(lines(305));
      pane.pushEntry(entry('la gota'));
      const drawn = drawnText().filter((text) => text === 'la gota');
      expect(drawn).toEqual(['la gota']);
      expect(buffer.buffer.entries).toHaveLength(5);
    });

    it('mirrors a swallowed line into the drawer feed', () => {
      pane.resetBuffer([]);
      pane.pushEntry(
        entry('ruido', { originalLevel: 'warn', silenced: true, level: null }),
      );
      const feed = document.getElementById('warn-feed');
      expect(feed?.childElementCount).toBe(1);
      expect(feed?.textContent).toContain('ruido');
    });
  });

  describe('trimMemory', () => {
    it('answers false when memory is still inside its cap', () => {
      view.view.memoryCap = 100;
      pane.resetBuffer(lines(10));
      expect(pane.trimMemory()).toBe(false);
      expect(buffer.buffer.entries).toHaveLength(10);
    });

    it('drops the oldest lines and follows the tail when that is where we were', () => {
      view.view.memoryCap = 4;
      pane.resetBuffer(lines(10));
      expect(pane.trimMemory()).toBe(true);
      expect(drawnText()).toEqual(['line 6', 'line 7', 'line 8', 'line 9']);
    });

    it('slides the window instead of jumping when the reader was scrolled back', () => {
      view.view.memoryCap = 8;
      pane.resetBuffer(lines(10));
      buffer.buffer.winStart = 2;
      buffer.buffer.winEnd = 5;
      pane.trimMemory();
      // Two lines went, so the same four lines now sit two positions lower.
      expect(buffer.buffer.winStart).toBe(0);
      expect(buffer.buffer.winEnd).toBe(3);
      expect(drawnText()).toEqual(['line 2', 'line 3', 'line 4', 'line 5']);
    });
  });

  describe('flashEntry', () => {
    it('centres the row it landed on and marks it', () => {
      pane.resetBuffer(lines(1000));
      pane.flashEntry(10);
      expect(scrolledIntoView).toHaveLength(1);
      const flashed = scrolledIntoView[0] as HTMLElement;
      expect(flashed.dataset.line).toBe('line 10');
      expect(flashed.classList.contains('flash')).toBe(true);
    });

    it('lets the mark fade instead of leaving it on forever', () => {
      pane.resetBuffer(lines(20));
      pane.flashEntry(3);
      const flashed = scrolledIntoView[0] as HTMLElement;
      vi.advanceTimersByTime(1600);
      expect(flashed.classList.contains('flash')).toBe(false);
    });

    it('does nothing for a line the current filter hides', () => {
      pane.resetBuffer([entry('api'), entry('web')]);
      elements.filterEl.value = 'api';
      pane.applyFilter();
      pane.flashEntry(1);
      expect(scrolledIntoView).toHaveLength(0);
    });
  });

  describe('showInContext', () => {
    it('drops every filter and lands on the line among its neighbours', () => {
      pane.resetBuffer([
        entry('antes'),
        entry('fallo', { originalLevel: 'error' }),
        entry('después'),
      ]);
      elements.filterEl.value = 'fallo';
      pane.applyFilter();
      pane.setLevelFilter(['error']);
      expect(drawnText()).toEqual(['fallo']);

      elements.autoscrollEl.checked = true;
      drawnRows()[0]?.querySelector<HTMLElement>('.ts')?.click();

      expect(elements.filterEl.value).toBe('');
      expect(elements.levelPillEl.hidden).toBe(true);
      expect(drawnText()).toEqual(['antes', 'fallo', 'después']);
      // Otherwise the tail yanks us straight back off the line we asked for.
      expect(elements.autoscrollEl.checked).toBe(false);
      expect((scrolledIntoView[0] as HTMLElement).dataset.line).toBe('fallo');
    });

    it('answers even when there was nothing to un-filter', () => {
      // A control that looks pressable and answers with silence teaches you to
      // stop pressing it.
      pane.resetBuffer([entry('sola')]);
      drawnRows()[0]?.querySelector<HTMLElement>('.ts')?.click();
      expect(scrolledIntoView).toHaveLength(1);
    });
  });

  describe('the scroll-to-bottom button', () => {
    it('hides itself while the tail is on screen, and resumes following', () => {
      pane.resetBuffer(lines(3));
      elements.autoscrollEl.checked = false;
      stubScroll({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
      pane.updateScrollButton();
      expect(elements.scrollBtn.classList.contains('visible')).toBe(false);
      expect(elements.autoscrollEl.checked).toBe(true);
    });

    it('appears when there are newer lines past the drawn window', () => {
      pane.resetBuffer(lines(10));
      buffer.buffer.winEnd = 4;
      pane.updateScrollButton();
      expect(elements.scrollBtn.classList.contains('visible')).toBe(true);
    });

    it('never resumes following while lines are selected', () => {
      pane.resetBuffer(lines(3));
      elements.autoscrollEl.checked = false;
      buffer.buffer.selected.add(0);
      stubScroll({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
      pane.updateScrollButton();
      expect(elements.autoscrollEl.checked).toBe(false);
    });

    it('moves the WINDOW to the tail, not merely the scrollbar', () => {
      pane.resetBuffer(lines(1000));
      buffer.buffer.winStart = 0;
      buffer.buffer.winEnd = 10;
      elements.autoscrollEl.checked = false;
      elements.scrollBtn.click();
      expect(drawnText().at(-1)).toBe('line 999');
      expect(elements.autoscrollEl.checked).toBe(true);
    });

    it('scrolling away from the tail stops following it', () => {
      pane.resetBuffer(lines(10));
      elements.autoscrollEl.checked = true;
      buffer.buffer.winEnd = 4;
      elements.mainEl.dispatchEvent(new Event('scroll'));
      expect(elements.autoscrollEl.checked).toBe(false);
    });
  });

  describe('rerenderExistingLines', () => {
    function commandTarget(patterns: {
      warn?: string[];
      error?: string[];
    }): void {
      view.view.currentTarget = {
        kind: 'command',
        group: { id: 'g1', name: 'Back' },
        target: {
          id: 'c1',
          name: 'api',
          silencedPatterns: {
            warn: patterns.warn ?? [],
            error: patterns.error ?? [],
          },
        },
      } as unknown as ViewModule['view']['currentTarget'];
    }

    it('swallows the held lines a new rule now matches', () => {
      pane.resetBuffer([
        entry('ruido conocido', { originalLevel: 'warn', level: 'warn' }),
        entry('otra cosa', { originalLevel: 'warn', level: 'warn' }),
      ]);
      commandTarget({ warn: ['ruido'] });
      pane.rerenderExistingLines();
      expect(buffer.buffer.entries[0]?.silenced).toBe(true);
      expect(buffer.buffer.entries[0]?.level).toBeNull();
      expect(buffer.buffer.entries[1]?.silenced).toBe(false);
      expect(buffer.buffer.entries[1]?.level).toBe('warn');
    });

    it('gives a line back its level when the rule that ate it is gone', () => {
      pane.resetBuffer([
        entry('ruido', { originalLevel: 'error', level: null, silenced: true }),
      ]);
      commandTarget({});
      pane.rerenderExistingLines();
      expect(buffer.buffer.entries[0]?.silenced).toBe(false);
      expect(buffer.buffer.entries[0]?.level).toBe('error');
    });

    it('repaints the rows, not just the buffer behind them', () => {
      pane.resetBuffer([
        entry('ruido', { originalLevel: 'warn', level: 'warn' }),
      ]);
      commandTarget({ warn: ['ruido'] });
      pane.rerenderExistingLines();
      expect(drawnRows()[0]?.classList.contains('silenced')).toBe(true);
    });

    it('leaves the buffer alone when the view has no single command', () => {
      pane.resetBuffer([
        entry('ruido', { originalLevel: 'warn', level: 'warn' }),
      ]);
      view.view.currentTarget = null;
      pane.rerenderExistingLines();
      expect(buffer.buffer.entries[0]?.silenced).toBeUndefined();
    });
  });

  describe('pausing', () => {
    it('says so, and holds the lines that arrive meanwhile', async () => {
      const status = await import('../renderer/logs/status.js');
      pane.resetBuffer(lines(1));
      elements.pausedEl.checked = true;
      elements.pausedEl.dispatchEvent(new Event('change'));
      expect(elements.statusEl.textContent).toBe('Pausado');
      status.queueWhilePaused(entry('mientras'));
      expect(drawnText()).toEqual(['line 0']);
    });

    it('resuming flushes everything that was held, in order', async () => {
      const status = await import('../renderer/logs/status.js');
      pane.resetBuffer(lines(1));
      elements.pausedEl.checked = true;
      elements.pausedEl.dispatchEvent(new Event('change'));
      status.queueWhilePaused(entry('primera'));
      status.queueWhilePaused(entry('segunda'));
      elements.pausedEl.checked = false;
      elements.pausedEl.dispatchEvent(new Event('change'));
      expect(drawnText()).toEqual(['line 0', 'primera', 'segunda']);
      expect(status.pendingQueue).toHaveLength(0);
    });
  });
});
