import { describe, expect, it } from 'vitest';
import {
  clampWindow,
  extendBottom,
  extendTop,
  initialWindow,
  windowAround,
  windowSize,
  type Win,
} from '../renderer/log-window.js';

const ROWS = 600;
const CHUNK = 300;
const MAX = ROWS + CHUNK; // the budget a window may never exceed

describe('initialWindow', () => {
  it('shows the tail, which is where a log is read from', () => {
    expect(initialWindow(10_000, ROWS)).toEqual({ start: 9400, end: 9999 });
  });

  it('shows everything when the list is smaller than the window', () => {
    expect(initialWindow(5, ROWS)).toEqual({ start: 0, end: 4 });
  });

  it('is empty for an empty list, without negative indices', () => {
    const win = initialWindow(0, ROWS);
    expect(windowSize(win)).toBe(0);
    expect(win.start).toBeGreaterThanOrEqual(0);
  });
});

describe('windowAround', () => {
  it('centres on the position', () => {
    expect(windowAround(5000, 10_000, ROWS)).toEqual({
      start: 4700,
      end: 5300,
    });
  });

  it('clamps at the start without losing rows off the front', () => {
    const win = windowAround(2, 10_000, ROWS);
    expect(win.start).toBe(0);
    expect(win.end).toBe(302);
  });

  it('clamps at the end', () => {
    const win = windowAround(9999, 10_000, ROWS);
    expect(win.end).toBe(9999);
  });
});

describe('extendTop', () => {
  it('adds a chunk above and drops the same from below', () => {
    const win = extendTop({ start: 9400, end: 9999 }, 10_000, CHUNK, ROWS);
    expect(win.start).toBe(9100);
    expect(windowSize(win)).toBeLessThanOrEqual(MAX);
  });

  it('reaches the very first line', () => {
    let win: Win = initialWindow(2000, ROWS);
    for (let i = 0; i < 50; i += 1) win = extendTop(win, 2000, CHUNK, ROWS);
    expect(win.start).toBe(0);
  });

  it('stays within budget however many times it grows', () => {
    let win: Win = initialWindow(50_000, ROWS);
    for (let i = 0; i < 200; i += 1) {
      win = extendTop(win, 50_000, CHUNK, ROWS);
      expect(windowSize(win)).toBeLessThanOrEqual(MAX);
    }
  });

  it('is a no-op once the top is reached', () => {
    const top = { start: 0, end: 100 };
    expect(extendTop(top, 1000, CHUNK, ROWS)).toEqual(top);
  });
});

describe('extendBottom', () => {
  it('adds a chunk below and drops the same from above', () => {
    const win = extendBottom({ start: 0, end: 599 }, 10_000, CHUNK, ROWS);
    expect(win.end).toBe(899);
    expect(windowSize(win)).toBeLessThanOrEqual(MAX);
  });

  it('reaches the very last line', () => {
    let win: Win = windowAround(0, 2000, ROWS);
    for (let i = 0; i < 50; i += 1) win = extendBottom(win, 2000, CHUNK, ROWS);
    expect(win.end).toBe(1999);
  });

  it('is a no-op at the bottom', () => {
    const bottom = { start: 9400, end: 9999 };
    expect(extendBottom(bottom, 10_000, CHUNK, ROWS)).toEqual(bottom);
  });
});

describe('walking the whole buffer', () => {
  it('covers every line with no gap, up then down', () => {
    const total = 5000;
    let win: Win = initialWindow(total, ROWS);
    const seen = new Set<number>();
    const record = (w: Win) => {
      for (let i = w.start; i <= w.end; i += 1) seen.add(i);
    };
    record(win);
    for (let i = 0; i < 100; i += 1) {
      win = extendTop(win, total, CHUNK, ROWS);
      record(win);
    }
    expect(win.start).toBe(0);
    for (let i = 0; i < 100; i += 1) {
      win = extendBottom(win, total, CHUNK, ROWS);
      record(win);
    }
    expect(win.end).toBe(total - 1);
    // Every index was rendered at some point: scrolling never skips a line.
    expect(seen.size).toBe(total);
  });
});

describe('clampWindow', () => {
  it('slides a window back inside a list that lost entries from the front', () => {
    // What a memory trim does: indices shift down by however many were dropped.
    expect(clampWindow(100 - 30, 300 - 30, 400)).toEqual({
      start: 70,
      end: 270,
    });
  });

  it('never produces negative indices when the shift overshoots', () => {
    const win = clampWindow(-50, 100, 400);
    expect(win.start).toBe(0);
    expect(win.end).toBe(100);
  });

  it('pulls the end back to the last entry', () => {
    expect(clampWindow(10, 9999, 100)).toEqual({ start: 10, end: 99 });
  });

  it('collapses to empty for an empty list', () => {
    expect(windowSize(clampWindow(10, 20, 0))).toBe(0);
  });
});
