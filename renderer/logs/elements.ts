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

export const drawerEl = byId<HTMLElement>('silenced-drawer', HTMLElement);
export const drawerTargetEl = byId<HTMLElement>('drawer-target', HTMLElement);
export const drawerCloseBtn = byId<HTMLButtonElement>(
  'drawer-close',
  HTMLButtonElement,
);
export const warnListEl = byId<HTMLUListElement>('warn-list', HTMLUListElement);
export const errListEl = byId<HTMLUListElement>('err-list', HTMLUListElement);
export const warnInputEl = byId<HTMLInputElement>(
  'warn-input',
  HTMLInputElement,
);
export const errInputEl = byId<HTMLInputElement>('err-input', HTMLInputElement);
export const warnAddBtn = byId<HTMLButtonElement>(
  'warn-add',
  HTMLButtonElement,
);
export const errAddBtn = byId<HTMLButtonElement>('err-add', HTMLButtonElement);
export const warnFeedEl = byId<HTMLElement>('warn-feed', HTMLElement);
export const errFeedEl = byId<HTMLElement>('err-feed', HTMLElement);

/** Write only when the content differs — keeps per-second updates flicker-free. */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}
