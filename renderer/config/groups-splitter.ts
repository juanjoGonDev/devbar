/**
 * The draggable divider between the groups list and the group editor.
 *
 * Until the user drags it, the list is as wide as its longest group name, so
 * short names do not waste room and long ones are not cut off. Once dragged,
 * the chosen width sticks (localStorage) until a double-click on the divider
 * hands control back to the automatic width. The behaviour itself lives in
 * `renderer/resizable-pane.ts`, shared with the logs window's sidebar.
 */

import { clampWidth } from './resize-handle.js';
import {
  createResizablePane,
  fitWidth,
  type ResizablePane,
} from '../resizable-pane.js';

const RANGE = { min: 140, max: 320 };
/** Matches the old fixed width, used until a row can be measured. */
const FALLBACK_WIDTH = 200;
const STORAGE_KEY = 'groups-list-width';

export function clampListWidth(width: number): number {
  return clampWidth(width, RANGE.min, RANGE.max);
}

/** The width that fits every row whole, given each row's full width. */
export function autoListWidth(rowWidths: readonly number[]): number {
  return fitWidth(rowWidths, RANGE);
}

export interface GroupsSplitterElements {
  /** Carries `--groups-list-width`, which the left pane reads. */
  twoPane: HTMLElement;
  /** The left pane, whose gutter around the rows is measured. */
  pane: HTMLElement;
  /** The `role="separator"` divider. */
  handle: HTMLElement;
  /** `#groups-list`, holding the `.nav-card` rows. */
  listEl: HTMLElement;
  /** Injected by tests: jsdom lays nothing out. */
  measureText?: (nameEl: HTMLElement) => number;
}

export function createGroupsSplitter(
  els: GroupsSplitterElements,
): ResizablePane {
  return createResizablePane({
    host: els.twoPane,
    pane: els.pane,
    handle: els.handle,
    listEl: els.listEl,
    ...RANGE,
    fallback: FALLBACK_WIDTH,
    storageKey: STORAGE_KEY,
    cssVar: '--groups-list-width',
    rowSelector: '.nav-card',
    nameSelector: '.nav-name',
    // The selected row sets its name in bold, which must not make a name
    // that just fit overflow.
    nameWeight: '600',
    ...(els.measureText && { measureText: els.measureText }),
  });
}
