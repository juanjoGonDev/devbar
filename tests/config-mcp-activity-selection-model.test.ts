import { describe, expect, it } from 'vitest';
import {
  clearSelection,
  count,
  createSelection,
  everyMatch,
  freshInfo,
  isEmpty,
  isPicked,
  pageState,
  pick,
  pickEveryMatch,
  setPicked,
  takeInfo,
  toWire,
} from '../renderer/config/mcp-activity-selection.js';

/**
 * The selection of «Actividad» as plain data: ids ticked one by one, every
 * match of a filter with its exceptions and extras, Shift ranges and the
 * answers main gives about it, which only count while they are current.
 */

const PAGE = ['a', 'b', 'c', 'd'];
const VIEW = '{"offset":0}';
const info = (total: number, onPage: string[] = [], all = false) => ({
  total,
  undoable: 0,
  oldest: null,
  view: { outside: 0, pages: 1, onPage, everyMatch: all },
});

describe('renderer/config/mcp-activity-selection.ts', () => {
  it('starts empty and ticks ids one by one', () => {
    const sel = createSelection();
    expect(isEmpty(sel)).toBe(true);
    setPicked(sel, ['a', 'c'], true);
    expect(isPicked(sel, 'a')).toBe(true);
    expect(count(sel)).toBe(2);
    expect(pageState(sel, PAGE)).toBe('some');
    expect(toWire(sel)).toEqual({ kind: 'ids', ids: ['a', 'c'] });
  });

  it('ticks a Shift range from the last row clicked, either way', () => {
    const sel = createSelection();
    pick(sel, PAGE, 'd', true, false);
    pick(sel, PAGE, 'b', true, true);
    expect(toWire(sel)).toEqual({ kind: 'ids', ids: ['d', 'b', 'c'] });
    pick(sel, PAGE, 'c', false, true);
    expect(toWire(sel)).toEqual({ kind: 'ids', ids: ['d'] });
  });

  it('picks a single row on Shift when the last one is not on the page', () => {
    const sel = createSelection();
    pick(sel, ['x'], 'x', true, false);
    pick(sel, PAGE, 'b', true, true);
    expect(toWire(sel)).toEqual({ kind: 'ids', ids: ['x', 'b'] });
  });

  it('turns into a filter with exceptions and extras', () => {
    const sel = createSelection();
    pickEveryMatch(sel, { search: 'x' }, 100, ['a', 'b']);
    expect(pageState(sel, ['a', 'b'])).toBe('all');
    expect(everyMatch(sel, { search: 'x' }, VIEW)).toBe(true);
    expect(everyMatch(sel, { search: 'y' }, VIEW)).toBe(false);

    setPicked(sel, ['a'], false);
    setPicked(sel, ['z'], true);
    expect(isPicked(sel, 'a')).toBe(false);
    expect(isPicked(sel, 'z')).toBe(true);
    expect(count(sel)).toBe(100);
    expect(everyMatch(sel, { search: 'x' }, VIEW)).toBe(false);
    expect(toWire(sel)).toEqual({
      kind: 'query',
      query: { search: 'x' },
      except: ['a'],
      include: ['z'],
    });

    setPicked(sel, ['a', 'z'], true);
    setPicked(sel, ['z'], false);
    expect(toWire(sel)).toEqual({ kind: 'query', query: { search: 'x' } });
  });

  it('takes main’s answer only for the selection it was about', () => {
    const sel = createSelection();
    pickEveryMatch(sel, {}, 10, []);
    const version = sel.version;
    takeInfo(sel, version, VIEW, info(7, ['c'], true));
    expect(count(sel)).toBe(7);
    expect(isPicked(sel, 'c')).toBe(true);
    expect(everyMatch(sel, { search: 'other' }, VIEW)).toBe(true);
    expect(freshInfo(sel, 'another view')).toBeNull();

    setPicked(sel, ['c'], false);
    takeInfo(sel, version, VIEW, info(1));
    expect(freshInfo(sel)).toBeNull();
    expect(count(sel)).toBe(9);
  });

  it('clears back to nothing', () => {
    const sel = createSelection();
    pickEveryMatch(sel, {}, 10, PAGE);
    clearSelection(sel);
    expect(isEmpty(sel)).toBe(true);
    expect(pageState(sel, PAGE)).toBe('none');
    expect(sel.info).toBeNull();
  });
});
