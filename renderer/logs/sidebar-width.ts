/**
 * How wide the sidebar is: as wide as its longest name until the user drags
 * the divider beside it, then whatever they chose, until a double-click on
 * the divider hands control back to the automatic width. The same behaviour
 * as the groups list in Settings (`renderer/resizable-pane.ts`).
 *
 * The range keeps the log readable: the attached window is at least 720px
 * wide, so even the widest sidebar leaves the log half of it.
 */
import { createResizablePane, type ResizablePane } from '../resizable-pane.js';

const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
/** The old fixed width, used until a row can be measured. */
const FALLBACK_WIDTH = 244;
const STORAGE_KEY = 'logs-list-width';

export interface SidebarWidthElements {
  /** Carries `--logs-list-width`, which `#sidebar` reads. */
  shell: HTMLElement;
  sidebar: HTMLElement;
  /** The `role="separator"` divider. */
  handle: HTMLElement;
  /** `#side-tree`, holding every row. */
  tree: HTMLElement;
  /** Injected by tests: jsdom lays nothing out. */
  measureText?: (nameEl: HTMLElement) => number;
}

export function createSidebarWidth(els: SidebarWidthElements): ResizablePane {
  const pane = createResizablePane({
    host: els.shell,
    pane: els.sidebar,
    handle: els.handle,
    listEl: els.tree,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    fallback: FALLBACK_WIDTH,
    storageKey: STORAGE_KEY,
    cssVar: '--logs-list-width',
    // «Todo», every group header and every service.
    rowSelector: '.side-all, .side-group > summary, .side-item',
    nameSelector: '.a-name, .g-name, .s-name',
    ...(els.measureText && { measureText: els.measureText }),
  });
  // A group opening or closing changes which names are on screen. `toggle`
  // does not bubble, so it is caught on its way down instead.
  els.tree.addEventListener('toggle', () => pane.refresh(), true);
  return pane;
}
