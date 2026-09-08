import { describe, it, expect } from 'vitest';
import {
  applySelection,
  selectModeFor,
  type Selection,
} from '../renderer/line-selection.js';

const mods = (
  patch: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>> = {},
) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...patch,
});

const sel = (indices: number[], anchor: number | null): Selection => ({
  selected: new Set(indices),
  anchor,
});

const list = (s: Selection) => [...s.selected].sort((a, b) => a - b);

describe('selectModeFor', () => {
  it('maps modifiers the way Windows and Finder do', () => {
    expect(selectModeFor(mods())).toBe('replace');
    expect(selectModeFor(mods({ metaKey: true }))).toBe('toggle');
    expect(selectModeFor(mods({ ctrlKey: true }))).toBe('toggle');
    expect(selectModeFor(mods({ shiftKey: true }))).toBe('range');
  });

  it('lets shift win over cmd/ctrl', () => {
    expect(selectModeFor(mods({ shiftKey: true, metaKey: true }))).toBe(
      'range',
    );
  });
});

describe('applySelection', () => {
  it('replaces the selection on a plain click', () => {
    const next = applySelection(sel([1, 2, 3], 1), 7, 'replace');
    expect(list(next)).toEqual([7]);
    expect(next.anchor).toBe(7);
  });

  it('adds and removes on toggle, moving the anchor each time', () => {
    let s = applySelection(sel([2], 2), 5, 'toggle');
    expect(list(s)).toEqual([2, 5]);
    expect(s.anchor).toBe(5);
    s = applySelection(s, 2, 'toggle');
    expect(list(s)).toEqual([5]);
    expect(s.anchor).toBe(2);
  });

  it('selects the inclusive range from the anchor, in either direction', () => {
    expect(list(applySelection(sel([2], 2), 5, 'range'))).toEqual([2, 3, 4, 5]);
    expect(list(applySelection(sel([5], 5), 2, 'range'))).toEqual([2, 3, 4, 5]);
  });

  it('keeps the anchor so repeated shift-clicks resize one range', () => {
    const first = applySelection(sel([3], 3), 8, 'range');
    expect(first.anchor).toBe(3);
    const shrunk = applySelection(first, 5, 'range');
    expect(list(shrunk)).toEqual([3, 4, 5]);
    expect(shrunk.anchor).toBe(3);
  });

  it('falls back to a plain click when there is no anchor yet', () => {
    const next = applySelection(sel([], null), 4, 'range');
    expect(list(next)).toEqual([4]);
    expect(next.anchor).toBe(4);
  });

  it('treats a range onto the anchor itself as just that row', () => {
    expect(list(applySelection(sel([2, 3, 4], 2), 2, 'range'))).toEqual([2]);
  });
});
