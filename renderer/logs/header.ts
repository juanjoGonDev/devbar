/**
 * The toolbar's left half: what is on screen («Grupo › Servicio»), how it is
 * doing (the run pill), and the controls that act on that service as a whole —
 * plus the actions the «⋯» menu offers on the view.
 *
 * `renderHeaderRunState` runs once a second for the ticking uptime, so every
 * write here is guarded against rewriting the same string.
 */
import { canRun, isRunning, runtimeOf } from '../log-status.js';
import { icon } from '../icon.js';
import { dropPendingQueue } from './status.js';
import { renderLevelChips, resetBuffer } from './pane.js';
import { crumbsFor, runPillFor } from './toolbar-model.js';
import {
  crumbGroupEl,
  crumbNameEl,
  crumbSepEl,
  restartBtn,
  runBtn,
  runPillEl,
  runPillTextEl,
  setText,
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

function renderCrumbs(): void {
  const crumbs = crumbsFor(view);
  crumbGroupEl.hidden = crumbs.group === null;
  crumbSepEl.hidden = crumbs.group === null;
  setText(crumbGroupEl, crumbs.group ?? '');
  setText(crumbNameEl, crumbs.name);
  crumbNameEl.title = crumbs.name;
}

/** The window title: what the native title bar and the window switcher show. */
function windowTitle(item: LogListItem | null): string {
  if (!view.processId) {
    if (view.mergedIsAll) return 'Telemetría';
    if (view.mergedGroupId) return `Logs — ${view.groupName} · todos`;
    return 'Logs';
  }
  const base = view.groupName
    ? `Logs — ${view.groupName} · ${view.displayName}`
    : `Logs — ${view.displayName}`;
  const runtime = runtimeOf(item);
  return runtime ? `${base} · ${runtime.text}` : base;
}

/** The pill and the run controls belong to a single service, never a merge. */
function renderRunControls(item: LogListItem | null): void {
  runPillEl.hidden = !item;
  if (item) {
    const pill = runPillFor(item);
    setText(runPillTextEl, pill.text);
    runPillEl.title = pill.title;
    runPillEl.dataset.tone = pill.tone;
  }
  const runnable = canRun(item);
  const running = isRunning(item);
  runBtn.hidden = !runnable;
  if (runnable) {
    const glyph = running ? 'square' : 'play';
    if (runBtn.dataset.glyph !== glyph) {
      runBtn.dataset.glyph = glyph;
      runBtn.replaceChildren(icon(glyph));
    }
    runBtn.title = running ? 'Parar' : 'Iniciar';
    runBtn.setAttribute('aria-label', runBtn.title);
    runBtn.classList.toggle('on', running);
  }
  // Restarting is stop-then-start, which only a command can do from here: an
  // action goes through its confirmation gate and is not "restarted".
  restartBtn.hidden = !(item?.type === 'command' && running);
}

export function renderHeaderRunState(): void {
  // A single service whose snapshot has not landed yet has nothing to say.
  if (view.processId && !view.displayName) return;
  const item = currentItem();
  renderCrumbs();
  renderRunControls(item);
  // This runs once a second for the ticking uptime. Writing the same string
  // back would still dirty the text node, so only touch what actually changed.
  const title = windowTitle(item);
  if (document.title !== title) document.title = title;
  renderLevelChips();
}

/** Stop, then start again — the same two calls the tray makes. */
async function restart(id: string): Promise<void> {
  await window.api.stopProcess(id);
  await window.api.startProcess(id);
}

runBtn.addEventListener('click', () => {
  const item = currentItem();
  if (item && canRun(item)) void toggleRun(item);
});

restartBtn.addEventListener('click', () => {
  const item = currentItem();
  if (item?.type === 'command' && isRunning(item)) void restart(item.id);
});

/**
 * Wipe the real retained buffer (main), not just the visible DOM — otherwise
 * cleared lines reappear on the next live line or when the window reopens.
 */
export async function clearLog(): Promise<void> {
  if (view.processId) await window.api.clearLogs(view.processId);
  resetBuffer([]);
  dropPendingQueue(); // resuming would re-add the very lines just cleared
}

/** Open the service on screen in a window of its own. */
export function detachLog(): void {
  if (view.processId)
    window.api.openLogs({ processId: view.processId, detached: true });
}
