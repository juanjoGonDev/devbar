// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry, mountLogsDom } from './helpers/logs-dom.js';
import type { LogEntry } from '../src/domain-types.js';

/**
 * `renderer/logs/selection-ui.ts` is the part of the selection you touch:
 * clicks, shift/ctrl ranges, ⌘A, ⌘C, Esc. The selection itself is keyed by
 * ENTRY (see `buffer.ts`), so what these tests pin is that what you pointed at
 * on screen — a position in the FILTERED list — lands on the right entry, and
 * that what reaches the clipboard is the buffer's text, not the DOM's.
 */
type BufferModule = typeof import('../renderer/logs/buffer.js');
type ElementsModule = typeof import('../renderer/logs/elements.js');
type PaneModule = typeof import('../renderer/logs/pane.js');

/**
 * `fmtTime` prints LOCAL time, so a fixed epoch offset would read differently
 * on a runner in another zone. Building the timestamps from local components
 * keeps the expected clock the same everywhere.
 */
function at(second: number, ms = 0): number {
  return new Date(2024, 0, 2, 3, 4, second, ms).getTime();
}

function lines(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry(`line ${i}`, { ts: at(i) }),
  );
}

describe('renderer/logs/selection-ui.ts', () => {
  let buffer: BufferModule;
  let elements: ElementsModule;
  let pane: PaneModule;
  let written: string[];
  let clipboardFails: boolean;

  beforeEach(async () => {
    vi.useFakeTimers();
    written = [];
    clipboardFails = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (clipboardFails) return Promise.reject(new Error('sin permiso'));
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    mountLogsDom();
    await import('../renderer/logs/selection-ui.js');
    buffer = await import('../renderer/logs/buffer.js');
    elements = await import('../renderer/logs/elements.js');
    pane = await import('../renderer/logs/pane.js');
  });

  afterEach(() => {
    // `getSelection` is stubbed per test; left in place it would make the next
    // test believe a text drag is in progress.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function rows(): HTMLElement[] {
    return Array.from(elements.linesEl.children) as HTMLElement[];
  }

  function clickRow(
    position: number,
    modifiers: Partial<MouseEventInit> = {},
  ): void {
    rows()[position]?.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    );
  }

  function selectedEntries(): number[] {
    return [...buffer.buffer.selected].sort((a, b) => a - b);
  }

  function markedRows(): string[] {
    return rows().flatMap((row) =>
      row.classList.contains('selected') ? [row.dataset.line ?? ''] : [],
    );
  }

  function key(
    k: string,
    modifiers: Partial<KeyboardEventInit> = {},
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    document.dispatchEvent(event);
    return event;
  }

  describe('picking rows with the mouse', () => {
    it('a plain click replaces the selection', () => {
      pane.resetBuffer(lines(4));
      clickRow(1);
      clickRow(3);
      expect(selectedEntries()).toEqual([3]);
      expect(markedRows()).toEqual(['line 3']);
    });

    it('cmd-click adds a second row without losing the first', () => {
      pane.resetBuffer(lines(4));
      clickRow(1);
      clickRow(3, { metaKey: true });
      expect(selectedEntries()).toEqual([1, 3]);
    });

    it('cmd-click on a chosen row takes it back out', () => {
      pane.resetBuffer(lines(4));
      clickRow(1);
      clickRow(3, { metaKey: true });
      clickRow(1, { metaKey: true });
      expect(selectedEntries()).toEqual([3]);
    });

    it('shift-click fills the range from the anchor', () => {
      pane.resetBuffer(lines(5));
      clickRow(1);
      clickRow(4, { shiftKey: true });
      expect(selectedEntries()).toEqual([1, 2, 3, 4]);
    });

    it('repeated shift-clicks grow and shrink the SAME range', () => {
      pane.resetBuffer(lines(5));
      clickRow(1);
      clickRow(4, { shiftKey: true });
      clickRow(2, { shiftKey: true });
      expect(selectedEntries()).toEqual([1, 2]);
    });

    it('shift-mousedown does not start a browser text selection instead', () => {
      pane.resetBuffer(lines(3));
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        shiftKey: true,
      });
      rows()[0]?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('selects the ENTRY behind the row, not its position on screen', () => {
      // With a filter on, the third row drawn is the sixth line held.
      pane.resetBuffer([
        entry('a 0'),
        entry('b 1'),
        entry('a 2'),
        entry('b 3'),
        entry('a 4'),
      ]);
      elements.filterEl.value = '^b';
      pane.applyFilter();
      clickRow(1);
      expect(selectedEntries()).toEqual([3]);
    });

    it('a click that only ended a text drag is not a row click', () => {
      pane.resetBuffer(lines(3));
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        removeAllRanges: () => undefined,
      } as unknown as Selection);
      clickRow(1);
      expect(selectedEntries()).toEqual([]);
    });

    it('ignores a row whose entry the filter has since hidden', () => {
      // Positions are re-derived per click from the CURRENT filtered list; a
      // row still on screen for an entry that left it points at nothing.
      pane.resetBuffer(lines(3));
      clickRow(0);
      const stale = rows()[1];
      if (stale) stale.dataset.eidx = '99';
      clickRow(1);
      expect(selectedEntries()).toEqual([0]);
    });

    it('clicking the empty space under the last line drops the selection', () => {
      pane.resetBuffer(lines(3));
      clickRow(1);
      elements.mainEl.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(selectedEntries()).toEqual([]);
      expect(markedRows()).toEqual([]);
    });
  });

  describe('the keyboard', () => {
    it('⌘F puts the cursor in the search box', () => {
      const focus = vi.spyOn(elements.filterEl, 'focus');
      const select = vi.spyOn(elements.filterEl, 'select');
      const event = key('f', { metaKey: true });
      expect(focus).toHaveBeenCalled();
      expect(select).toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it('⌘A takes everything the filter leaves', () => {
      pane.resetBuffer([entry('a 0'), entry('b 1'), entry('a 2')]);
      elements.filterEl.value = '^a';
      pane.applyFilter();
      key('a', { metaKey: true });
      expect(selectedEntries()).toEqual([0, 2]);
      expect(buffer.buffer.anchorEntry).toBe(0);
    });

    it('leaves the shortcuts alone while someone is typing in a box', () => {
      pane.resetBuffer(lines(3));
      elements.filterEl.focus();
      key('a', { metaKey: true });
      expect(selectedEntries()).toEqual([]);
    });

    it('⌘C copies the selection', async () => {
      pane.resetBuffer(lines(3));
      clickRow(0);
      clickRow(2, { metaKey: true });
      key('c', { metaKey: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toEqual(['03:04:00.000 line 0\n03:04:02.000 line 2']);
    });

    it('⌘C with nothing selected leaves the browser to it', async () => {
      pane.resetBuffer(lines(3));
      const event = key('c', { metaKey: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });

    it('⌘C over a real text selection copies exactly that instead', async () => {
      pane.resetBuffer(lines(3));
      clickRow(0);
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        removeAllRanges: () => undefined,
      } as unknown as Selection);
      const event = key('c', { metaKey: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });

    it('Esc drops the selection', () => {
      pane.resetBuffer(lines(3));
      clickRow(1);
      key('Escape');
      expect(selectedEntries()).toEqual([]);
    });

    it('ignores a plain letter nobody asked for', () => {
      pane.resetBuffer(lines(3));
      clickRow(1);
      key('a');
      expect(selectedEntries()).toEqual([1]);
    });
  });

  describe('the copy button', () => {
    it('copies the picked lines, timestamped and stripped of ANSI', async () => {
      pane.resetBuffer([
        entry('[31mrojo[0m', { ts: at(5, 6) }),
        entry('otra', { ts: at(6) }),
      ]);
      clickRow(0);
      elements.copyBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toEqual(['03:04:05.006 rojo']);
    });

    it('copies the whole FILTERED buffer when nothing is picked', async () => {
      // Not merely the drawn window: the filter is what the reader asked for.
      pane.resetBuffer([
        entry('a 0', { ts: at(0) }),
        entry('b 1', { ts: at(1) }),
        entry('a 2', { ts: at(2) }),
      ]);
      elements.filterEl.value = '^a';
      pane.applyFilter();
      elements.copyBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toEqual(['03:04:00.000 a 0\n03:04:02.000 a 2']);
    });

    it('says how many lines went, then goes back to reporting the selection', async () => {
      pane.resetBuffer(lines(3));
      clickRow(0);
      clickRow(1, { metaKey: true });
      elements.copyBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.statusEl.textContent).toBe('Copiado ✓ (2)');
      await vi.advanceTimersByTimeAsync(1500);
      expect(elements.statusEl.textContent).toBe('2 seleccionada(s)');
    });

    it('says so when the clipboard refused', async () => {
      clipboardFails = true;
      pane.resetBuffer(lines(2));
      clickRow(0);
      elements.copyBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.statusEl.textContent).toBe('Error al copiar');
    });
  });
});
