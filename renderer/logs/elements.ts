/**
 * Every element the logs window binds, resolved once.
 *
 * `byId` asserts the tag as it resolves and throws on a mismatch, which kills
 * the window: keeping all of them in one module means one place to read the
 * window's contract with its markup, and one file for
 * `tests/renderer-dom-contract.test.ts` to cross-check against `logs.html`.
 */
import { byId, requireElement } from '../dom.js';

export const titleEl = byId<HTMLElement>('title', HTMLElement);
export const uptimeBadgeEl = byId<HTMLElement>('uptime-badge', HTMLElement);
export const linesEl = byId<HTMLElement>('lines', HTMLElement);
export const filterEl = byId<HTMLInputElement>('filter', HTMLInputElement);
export const autoscrollEl = byId<HTMLInputElement>(
  'autoscroll',
  HTMLInputElement,
);
export const pausedEl = byId<HTMLInputElement>('paused', HTMLInputElement);
export const clearBtn = byId<HTMLButtonElement>('clear', HTMLButtonElement);
export const copyBtn = byId<HTMLButtonElement>('copy', HTMLButtonElement);
export const clearSelectionBtn = byId<HTMLButtonElement>(
  'clear-selection',
  HTMLButtonElement,
);
export const countsEl = byId<HTMLElement>('counts', HTMLElement);
export const statusEl = byId<HTMLElement>('status', HTMLElement);
export const mainEl = requireElement<HTMLElement>('main', HTMLElement);
export const muteWarnEl = byId<HTMLInputElement>('mute-warn', HTMLInputElement);
export const muteErrEl = byId<HTMLInputElement>('mute-err', HTMLInputElement);
export const togglePanelBtn = byId<HTMLButtonElement>(
  'toggle-silenced',
  HTMLButtonElement,
);
export const levelPillEl = byId<HTMLButtonElement>(
  'level-pill',
  HTMLButtonElement,
);
export const levelPillTextEl = byId<HTMLElement>(
  'level-pill-text',
  HTMLElement,
);
export const scrollBtn = byId<HTMLButtonElement>(
  'scroll-bottom',
  HTMLButtonElement,
);
export const runBtn = byId<HTMLButtonElement>('run-toggle', HTMLButtonElement);
export const detachBtn = byId<HTMLButtonElement>('detach', HTMLButtonElement);
export const sideTreeEl = byId<HTMLElement>('side-tree', HTMLElement);
export const sideFilterEl = byId<HTMLInputElement>(
  'side-filter',
  HTMLInputElement,
);
export const toggleSidebarBtn = byId<HTMLButtonElement>(
  'toggle-sidebar',
  HTMLButtonElement,
);

export const toggleLabelEl = byId<HTMLElement>(
  'silence-toggle-label',
  HTMLElement,
);
export const drawerEl = byId<HTMLElement>('silenced-drawer', HTMLElement);
export const drawerCloseBtn = byId<HTMLButtonElement>(
  'drawer-close',
  HTMLButtonElement,
);
export const segWarnBtn = byId<HTMLButtonElement>(
  'seg-warn',
  HTMLButtonElement,
);
export const segErrBtn = byId<HTMLButtonElement>('seg-err', HTMLButtonElement);
export const segWarnCountEl = byId<HTMLElement>('seg-warn-count', HTMLElement);
export const segErrCountEl = byId<HTMLElement>('seg-err-count', HTMLElement);
export const draftCardEl = byId<HTMLElement>('draft-card', HTMLElement);
export const draftInputEl = byId<HTMLInputElement>(
  'draft-input',
  HTMLInputElement,
);
export const draftRegexBtn = byId<HTMLButtonElement>(
  'draft-regex',
  HTMLButtonElement,
);
export const draftErrorEl = byId<HTMLElement>('draft-error', HTMLElement);
export const draftMetaEl = byId<HTMLElement>('draft-meta', HTMLElement);
export const draftCountEl = byId<HTMLElement>('draft-count', HTMLElement);
export const draftSamplesEl = byId<HTMLElement>('draft-samples', HTMLElement);
export const patternListEl = byId<HTMLUListElement>(
  'pattern-list',
  HTMLUListElement,
);
export const silencePreviewEl = byId<HTMLElement>(
  'silence-preview',
  HTMLElement,
);
export const silencePreviewTextEl = byId<HTMLElement>(
  'silence-preview-text',
  HTMLElement,
);

/** Write only when the content differs — keeps per-second updates flicker-free. */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}
