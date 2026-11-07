// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom } from './helpers/logs-dom.js';

/**
 * `renderer/logs/footer.ts` owns the two display switches on the right of the
 * footer — «Ajustar líneas» and «Hora: absoluta/relativa» — and the ticker
 * that keeps relative times current. Both are remembered between windows.
 */
type PaneModule = typeof import('../renderer/logs/pane.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');

const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();

describe('renderer/logs/footer.ts', () => {
  let pane: PaneModule;
  let elements: ElementsModule;

  /** Mount, optionally with saved preferences, and load the footer. */
  async function load(saved: Record<string, string> = {}): Promise<void> {
    mountLogsDom();
    for (const [key, value] of Object.entries(saved))
      localStorage.setItem(key, value);
    pane = await import('../renderer/logs/pane.js');
    elements = await import('../renderer/logs/elements.js');
    await import('../renderer/logs/footer.js');
  }

  function stamps(): string[] {
    return Array.from(
      elements.linesEl.querySelectorAll<HTMLElement>('.line .ts'),
      (el) => el.textContent ?? '',
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Ajustar líneas', () => {
    it('wraps long lines by default', async () => {
      await load();
      expect(elements.wrapLinesEl.checked).toBe(true);
      expect(elements.linesEl.classList.contains('nowrap')).toBe(false);
    });

    it('switched off, keeps each line on one row, and remembers it', async () => {
      await load();
      elements.wrapLinesEl.click();
      expect(elements.linesEl.classList.contains('nowrap')).toBe(true);
      expect(localStorage.getItem('devbar.logs.wrap')).toBe('off');
    });

    it('comes back the way it was left', async () => {
      await load({ 'devbar.logs.wrap': 'off' });
      expect(elements.wrapLinesEl.checked).toBe(false);
      expect(elements.linesEl.classList.contains('nowrap')).toBe(true);
    });
  });

  describe('Hora', () => {
    it('shows the clock by default', async () => {
      await load();
      pane.resetBuffer([entry('a', { ts: NOW - 12_000 })]);
      expect(elements.timeModeBtn.textContent).toContain('absoluta');
      expect(stamps()).toEqual(['11:59:48.000']);
    });

    it('pressed, says how long ago each line was, and remembers it', async () => {
      await load();
      pane.resetBuffer([entry('a', { ts: NOW - 12_000 })]);
      elements.timeModeBtn.click();
      expect(elements.timeModeBtn.textContent).toContain('relativa');
      expect(stamps()).toEqual(['hace 12 s']);
      expect(localStorage.getItem('devbar.logs.time')).toBe('relative');
      elements.timeModeBtn.click();
      expect(stamps()).toEqual(['11:59:48.000']);
    });

    it('draws rows built later in the chosen mode', async () => {
      await load({ 'devbar.logs.time': 'relative' });
      pane.resetBuffer([entry('a', { ts: NOW - 3 * 60_000 })]);
      expect(stamps()).toEqual(['hace 3 min']);
    });

    it('keeps relative times current without rebuilding the rows', async () => {
      await load({ 'devbar.logs.time': 'relative' });
      pane.resetBuffer([entry('a', { ts: NOW - 1_000 })]);
      const row = elements.linesEl.firstElementChild;
      vi.advanceTimersByTime(10_000);
      expect(stamps()).toEqual(['hace 11 s']);
      expect(elements.linesEl.firstElementChild).toBe(row);
    });
  });
});
