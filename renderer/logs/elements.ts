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

export const silenceToggleBtn = byId<HTMLButtonElement>(
  'toggle-silenced',
  HTMLButtonElement,
);
export const silenceToggleCountEl = byId<HTMLElement>(
  'silence-toggle-count',
  HTMLElement,
);
export const popoverEl = byId<HTMLElement>('silence-popover', HTMLElement);
export const composerEl = byId<HTMLElement>('silence-composer', HTMLElement);
export const draftInputEl = byId<HTMLInputElement>(
  'silence-input',
  HTMLInputElement,
);
export const draftCountEl = byId<HTMLElement>('silence-count', HTMLElement);
export const draftRegexBtn = byId<HTMLButtonElement>(
  'silence-regex',
  HTMLButtonElement,
);
export const draftErrorEl = byId<HTMLElement>('silence-error', HTMLElement);
export const levelWarnBtn = byId<HTMLButtonElement>(
  'silence-level-warn',
  HTMLButtonElement,
);
export const levelErrBtn = byId<HTMLButtonElement>(
  'silence-level-error',
  HTMLButtonElement,
);
export const submitBtn = byId<HTMLButtonElement>(
  'silence-submit',
  HTMLButtonElement,
);
export const patternListEl = byId<HTMLUListElement>(
  'silence-rules',
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
