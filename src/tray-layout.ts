/**
 * Where what is hidden from the tray goes — groups and workflows alike: after
 * the rest, behind the «N oculto(s)» fold — or, with that fold turned off in
 * the settings, nowhere. One rule for the tray popover and for a linked
 * phone, so the two never disagree about what they list.
 */
import type { WorkflowEntry } from './ipc-contract.js';

export interface FoldLayout<T> {
  /** Listed as usual, in their order. */
  shown: T[];
  /** The hidden ones, listed behind the fold; empty when it is off. */
  folded: T[];
}

export function foldHidden<T>(
  items: readonly T[],
  isHidden: (item: T) => boolean,
  showFold: boolean,
): FoldLayout<T> {
  return {
    shown: items.filter((item) => !isHidden(item)),
    folded: showFold ? items.filter(isHidden) : [],
  };
}

export function trayGroupLayout<T extends { group: { hiddenInTray: boolean } }>(
  states: readonly T[],
  showHiddenGroupsFold: boolean,
): FoldLayout<T> {
  return foldHidden(
    states,
    (state) => state.group.hiddenInTray,
    showHiddenGroupsFold,
  );
}

/** Hidden, and not running: a running workflow is always in plain sight. */
function folds(entry: WorkflowEntry): boolean {
  return entry.running === null && entry.workflow.hidden;
}

/** Enabled with something to run — or running, whatever its settings. */
function runnable(entry: WorkflowEntry): boolean {
  if (entry.running) return true;
  return entry.workflow.enabled && entry.scriptCount > 0;
}

/** Where a row goes: running first, then startup, manual, scheduled. */
function rank(entry: WorkflowEntry): number {
  if (entry.running) return 0;
  const order = { startup: 1, manual: 2, schedule: 3 } as const;
  return order[entry.workflow.trigger.kind];
}

/**
 * The workflows the tray and a linked phone list, in their order, the hidden
 * ones behind the fold. A disabled workflow or one with nothing to run is
 * left out; a running one is always listed, outside the fold.
 */
export function trayWorkflowLayout(
  entries: readonly WorkflowEntry[],
  showHiddenWorkflowsFold: boolean,
): FoldLayout<WorkflowEntry> {
  const listed = entries
    .filter(runnable)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  return foldHidden(listed, folds, showHiddenWorkflowsFold);
}

/**
 * Whether the tray and the phone list this workflow at all (in plain sight
 * or behind the fold) — what lets a phone run and stop it.
 */
export function workflowListed(
  entry: WorkflowEntry,
  showHiddenWorkflowsFold: boolean,
): boolean {
  return runnable(entry) && (showHiddenWorkflowsFold || !folds(entry));
}
