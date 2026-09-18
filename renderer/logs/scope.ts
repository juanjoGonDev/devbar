/**
 * Switching what the window is looking at.
 *
 * Three scopes — one service, one group merged, everything merged — and one
 * way in for all of them, so the level pin, the buffer reset and the sidebar
 * highlight behave identically no matter which control was pressed.
 *
 * Every switch takes a load ticket before it asks main for a snapshot: a
 * second switch started meanwhile wins, and the first one's answer is dropped
 * on arrival instead of being appended to a buffer it no longer owns.
 */
import { buildFilter } from './filters.js';
import { buffer } from './buffer.js';
import { logsParams } from './params.js';
import {
  EDGE_CHUNK,
  flashEntry,
  renderLevelChips,
  resetBuffer,
  setLevelFilter,
  trimMemory,
} from './pane.js';
import { applyTargetSnapshot, clearMutedFeeds, setDrawer } from './drawer.js';
import { renderHeaderRunState } from './header.js';
import {
  awaitSnapshot,
  beginLoad,
  dropUnknownSources,
  endLoad,
} from './stream.js';
import { dropPendingQueue, keepQueuedAfter } from './status.js';
import {
  autoscrollEl,
  filterEl,
  muteErrEl,
  muteWarnEl,
  runBtn,
  setText,
  sideTreeEl,
  titleEl,
  uptimeBadgeEl,
} from './elements.js';
import { view, type Scope } from './view.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

/** Open any scope, optionally pinned to the levels the caller cares about. */
export async function openScope(
  scope: Scope,
  levels: readonly SilenceLevel[] = [],
): Promise<void> {
  setLevelFilter(levels);
  if (scope.kind === 'single') await selectLog(scope.processId);
  else await selectMergedLog(scope.kind === 'group' ? scope.groupId : null);
}

/**
 * Jump from a merged row into that service's own view, landing on the same
 * line. The timestamp is the handle: it survives the switch, the row does not.
 */
export async function jumpToLine(srcId: string, ts: number): Promise<void> {
  await openScope({ kind: 'single', processId: srcId }, [...view.levelFilter]);
  // Search the BUFFER, not the DOM: after the switch the line is almost
  // certainly outside the drawn window, so the window is moved to it.
  const entryIndex = buffer.entries.findIndex((entry) => entry.ts === ts);
  if (entryIndex < 0) return;
  autoscrollEl.checked = false;
  flashEntry(entryIndex);
}

/**
 * Merge several services into one stream: a whole group, or every group when
 * `groupId` is null (the generic telemetry view). Each row is tagged with its
 * source, so a mixed feed stays readable without splitting the window.
 * Selecting an individual service afterwards drops back to single mode.
 */
async function selectMergedLog(groupId: string | null): Promise<void> {
  view.processId = null;
  dropUnknownSources(); // held lines belong to the old scope
  clearMutedFeeds(); // rows from the previous scope would target the wrong command
  view.mergedIsAll = groupId === null;
  view.mergedGroupId = groupId;
  resetBuffer([]);
  dropPendingQueue();
  view.currentTarget = null;
  view.currentGroupId = null;
  view.currentCommandId = null;
  setDrawer(false); // silencing is per-service; it has no meaning here

  view.memoryCap = view.globalRetention; // merged snapshots are capped globally
  const token = beginLoad();
  const res = await awaitSnapshot(window.api.getMergedLogs(groupId), token);
  if (!token()) return; // a newer load won the race, and owns the queue
  view.groupSources = new Map(res.sources.map((s) => [s.id, s]));
  view.displayName = groupId ? 'todos' : '';
  view.groupName = res.groupName;
  const heading = groupId ? `Logs — ${res.groupName} · todos` : 'Telemetría';
  setText(titleEl, heading);
  document.title = heading;
  uptimeBadgeEl.classList.remove('visible');
  runBtn.style.display = 'none';
  renderLevelChips();

  resetBuffer([...res.lines]);
  endLoad((id) => res.seqs[id] ?? 0);
  markMergedInSidebar(groupId);
}

function markMergedInSidebar(groupId: string | null): void {
  for (const row of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-item'),
  ))
    row.classList.remove('active');
  for (const summary of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  ))
    summary.classList.toggle('viewing', summary.dataset.groupId === groupId);
  sideTreeEl
    .querySelector<HTMLElement>('.side-all')
    ?.classList.toggle('active', view.mergedIsAll);
}

export async function selectLog(
  id: string,
  filter?: string,
  level?: SilenceLevel,
): Promise<void> {
  view.processId = id;
  view.groupSources = null;
  view.mergedGroupId = null;
  dropUnknownSources(); // held lines belong to the old scope
  clearMutedFeeds(); // rows from the previous scope would target the wrong command
  view.mergedIsAll = false;
  for (const summary of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  ))
    summary.classList.remove('viewing');
  sideTreeEl
    .querySelector<HTMLElement>('.side-all')
    ?.classList.remove('active');
  resetBuffer([]);
  dropPendingQueue();
  view.currentTarget = null;
  view.currentGroupId = null;
  view.currentCommandId = null;
  muteWarnEl.checked = false;
  muteErrEl.checked = false;
  if (filter !== undefined) filterEl.value = filter;
  else if (level)
    // A severity entry point (tray counter) pins the level chip but sent no
    // filter: a stale text filter from the previous view would hide the very
    // entries the counter represents.
    filterEl.value = '';
  view.filterRe = buildFilter(filterEl.value);
  // A counter-button entry point (tray, in-window nav) pins the level chip;
  // a plain log switch keeps whatever the user has on screen.
  if (level) setLevelFilter([level]);

  // getLogs also points main's live stream at this buffer, atomically.
  const token = beginLoad();
  const res = await awaitSnapshot(window.api.getLogs(id), token);
  if (!token()) return; // a newer load won the race, and owns the queue
  view.memoryCap = res.logLimit; // whatever main kept for it, not what config says now
  view.watchedStartedAt = res.commandState.startedAt;

  const target = res.target;
  if (target && target.group && target.target) {
    applyTargetSnapshot(target);
    view.displayName = target.target.name || id;
    view.groupName = target.group.name;
    if (target.kind === 'command') {
      view.currentGroupId = target.group.id;
      view.currentCommandId = target.target.id;
    }
  } else {
    view.displayName = id;
    view.groupName = '';
  }

  resetBuffer([...res.lines]);
  endLoad(() => res.seq);
  if (!logsParams.isDetached) {
    for (const row of Array.from(
      sideTreeEl.querySelectorAll<HTMLElement>('.side-item'),
    )) {
      row.classList.toggle('active', row.dataset.id === id);
    }
  }
  renderHeaderRunState();
}

/**
 * Follow the watched process across a restart and across a retention change.
 * Both leave the viewer holding lines main has already dropped — offering them
 * to the filter and to copy — and neither announces itself as anything more
 * than a state change.
 */
export function syncWatched(): void {
  if (!view.processId) return;
  const item = view.sideData
    .flatMap((group) => group.items)
    .find((candidate) => candidate.id === view.processId);
  if (!item) return;
  if (item.startedAt !== view.watchedStartedAt && item.startedAt !== null) {
    void reloadWatched(); // a new run: the previous one's lines are gone
    return;
  }
  if (item.logLimit === view.memoryCap) return;
  view.memoryCap = item.logLimit;
  if (buffer.entries.length > view.memoryCap + EDGE_CHUNK) trimMemory();
}

/** Replace the buffer with main's, for when ours describes a run that ended. */
async function reloadWatched(): Promise<void> {
  const id = view.processId;
  if (!id) return;
  const token = beginLoad();
  const res = await awaitSnapshot(window.api.getLogs(id), token);
  // The view may have moved on, and a reload must not outlive its target.
  if (!token() || view.processId !== id) return;
  view.watchedStartedAt = res.commandState.startedAt;
  view.memoryCap = res.logLimit;
  // Everything the queue holds at or below this is in the snapshot already:
  // the finished run's lines, and the '▶ start' of the new one. What arrived
  // after main read the buffer is genuinely ours to keep.
  keepQueuedAfter(() => res.seq); // held from before the reload began
  resetBuffer([...res.lines]);
  endLoad(() => res.seq); // arrived while it was in flight
}
