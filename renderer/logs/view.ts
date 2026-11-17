/**
 * The state every pane of the logs window reads, in one place.
 *
 * The window is one screen made of several panes — the line list, the
 * sidebar, the silenced popover, the header — and they all answer questions
 * about the SAME thing: which scope is on screen, which levels it is pinned
 * to, what main last told us about the services. Splitting that state per
 * pane would mean each one holding its own copy and the copies drifting; this
 * module keeps a single answer and no pane owns it.
 *
 * It imports nothing but types — and the engine's state factory, which imports
 * nothing but the pure live-state module — on purpose: it is the bottom of the
 * graph, so any pane may read it without creating a cycle. Its engine half
 * (`LogViewState`) is what the shared log pane reads; the rest is the
 * window's own.
 */
import type {
  LogListGroup,
  LogListItem,
  LogsTarget,
  SilenceLevel,
} from '../../src/ipc-contract.js';
import {
  createLogViewState,
  type FindHooks,
  type LogViewState,
} from '../log-view/context.js';

/**
 * The three scopes the window can show. Every entry point — nav counters, tray
 * icons, a line's own tags — resolves to one of these, optionally pinned to a
 * level. Keeping it one type is what makes the level filter behave identically
 * everywhere instead of once per view.
 */
export type Scope =
  | { kind: 'all' }
  | { kind: 'group'; groupId: string }
  | { kind: 'single'; processId: string };

export interface LogsView extends LogViewState {
  /** Current resolved target (group + command/action). */
  currentTarget: LogsTarget | null;
  /** groupId + commandId extracted from processId for silence ops. */
  currentGroupId: string | null;
  currentCommandId: string | null;
  /** Distinguishes the generic view from a single-group one; both are merged. */
  mergedIsAll: boolean;
  /** The global setting, for views with no override of their own. */
  globalRetention: number;
  /**
   * The run our buffer belongs to. `start()` empties main's buffer, so a
   * restart makes every line we hold history that no longer exists behind it.
   */
  watchedStartedAt: number | null;
  /**
   * Last sidebar snapshot — also the source of truth for the header's run
   * button and uptime, so commands, actions and pre-scripts all work the same.
   */
  sideData: LogListGroup[];
  /** Name of what is on screen, and of the group it belongs to. */
  displayName: string;
  groupName: string;
}

export const view: LogsView = {
  ...createLogViewState(),
  currentTarget: null,
  currentGroupId: null,
  currentCommandId: null,
  mergedIsAll: false,
  globalRetention: 20_000,
  watchedStartedAt: null,
  sideData: [],
  displayName: '',
  groupName: '',
};

export function itemById(id: string): LogListItem | null {
  for (const group of view.sideData) {
    for (const item of group.items) if (item.id === id) return item;
  }
  return null;
}

export function currentItem(): LogListItem | null {
  return view.processId ? itemById(view.processId) : null;
}

/**
 * The scope switcher, handed in rather than imported.
 *
 * `scope.ts` sits ABOVE the panes it repaints, so a row that opens another
 * scope — a source tag, a warning counter — cannot import it back without a
 * cycle, and dependency-cruiser fails the build on one. The entry point wires
 * the real implementation in once, before any of those controls can be
 * pressed.
 */
export interface LogsNav {
  openScope(scope: Scope, levels?: readonly SilenceLevel[]): Promise<void>;
  jumpToLine(srcId: string, ts: number): Promise<void>;
}

export const nav = {} as LogsNav;

export function installNav(next: LogsNav): void {
  Object.assign(nav, next);
}

/**
 * The silenced popover's entry points, handed in for the same reason as `nav`:
 * a row's silence action prefills the popover's draft, and `row-actions.ts`
 * sits below the popover. The popover installs itself when it loads.
 */
export interface SilenceHooks {
  /** Open the popover on `level` with `pattern` (in storage form) as the draft. */
  prefill(level: SilenceLevel, pattern: string): void;
}

export const silenceHooks = {} as SilenceHooks;

export function installSilenceHooks(next: SilenceHooks): void {
  Object.assign(silenceHooks, next);
}

/**
 * The pane's repaint, handed to the rows for the same reason as `nav`: a row
 * that folds or unfolds itself (a stack trace, a JSON line) changes what the
 * rows around it look like, and `rows.ts` sits below the pane that draws them.
 */
export interface RowHooks {
  /** Rebuild the drawn rows in place, keeping the reader where they were. */
  repaint(): void;
}

export const rowHooks = {} as RowHooks;

export function installRowHooks(next: RowHooks): void {
  Object.assign(rowHooks, next);
}

/**
 * The find widget's side of the pane, handed in for the same reason as `nav`:
 * the widget drives the pane (it re-filters, scrolls, repaints), so the pane
 * cannot import it back. Until the widget installs itself nothing is searched,
 * and every hook is a no-op.
 */
export const findHooks: FindHooks = {
  recount: () => undefined,
  appended: () => undefined,
  trimmed: () => undefined,
  filterDropped: () => undefined,
  levelPinned: () => undefined,
};

export function installFindHooks(next: FindHooks): void {
  Object.assign(findHooks, next);
}
