/**
 * The window's own title bar and toolbar: what is on screen, how long it has
 * been running, and the controls that act on it as a whole.
 *
 * `renderHeaderRunState` runs once a second for the ticking uptime, so every
 * write here is guarded against rewriting the same string.
 */
import { canRun, isRunning, runtimeOf } from '../log-status.js';
import { dropPendingQueue } from './status.js';
import { renderLevelChips, resetBuffer } from './pane.js';
import {
  clearBtn,
  detachBtn,
  runBtn,
  setText,
  titleEl,
  uptimeBadgeEl,
} from './elements.js';
import { currentItem, itemById, view } from './view.js';
import type { LogListItem } from '../../src/ipc-contract.js';

async function toggleRun(item: LogListItem): Promise<void> {
  if (isRunning(item)) {
    await window.api.stopProcess(item.id);
    return;
  }
  // Actions go through actions:run so their confirmation gate still applies.
  if (item.type === 'action') {
    const parts = item.id.split(':');
    const groupId = parts[1];
    const actionId = parts.slice(2).join(':');
    if (groupId && actionId) await window.api.runAction(groupId, actionId);
    return;
  }
  await window.api.startProcess(item.id);
}

/** Resolve the row's current state on click, not the snapshot it was built from. */
export function toggleRunById(id: string): void {
  const fresh = itemById(id);
  if (fresh) void toggleRun(fresh);
}

export function renderHeaderRunState(): void {
  if (!view.processId || !view.displayName) return;
  const item = currentItem();
  const runnable = canRun(item);
  runBtn.style.display = runnable ? '' : 'none';
  if (runnable) {
    const running = isRunning(item);
    runBtn.textContent = running ? '■' : '▶';
    runBtn.title = running ? 'Parar' : 'Arrancar';
    runBtn.classList.toggle('on', running);
  }
  const runtime = runtimeOf(item);
  const base = view.groupName
    ? `Logs — ${view.groupName} · ${view.displayName}`
    : `Logs — ${view.displayName}`;
  const uptime = runtime
    ? runtime.live
      ? runtime.text
      : `último: ${runtime.text}`
    : '';
  // This runs once a second for the ticking uptime. Writing the same string
  // back would still dirty the text node, so only touch what actually changed.
  setText(titleEl, base);
  setText(uptimeBadgeEl, uptime);
  uptimeBadgeEl.classList.toggle('visible', Boolean(runtime));
  const fullTitle = runtime ? `${base} · ${runtime.text}` : base;
  if (document.title !== fullTitle) document.title = fullTitle;
  renderLevelChips();
}

runBtn.addEventListener('click', () => {
  const item = currentItem();
  if (item && canRun(item)) void toggleRun(item);
});

clearBtn.addEventListener('click', async () => {
  // Wipe the real retained buffer (main), not just the visible DOM — otherwise
  // cleared lines reappear on the next live line or when the window reopens.
  if (view.processId) await window.api.clearLogs(view.processId);
  resetBuffer([]);
  dropPendingQueue(); // resuming would re-add the very lines just cleared
});

detachBtn.addEventListener('click', () => {
  if (view.processId)
    window.api.openLogs({ processId: view.processId, detached: true });
});
