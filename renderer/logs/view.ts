/**
 * The state every pane of the logs window reads, in one place.
 *
 * The window is one screen made of several panes — the line list, the
 * sidebar, the silenced drawer, the header — and they all answer questions
 * about the SAME thing: which scope is on screen, which levels it is pinned
 * to, what main last told us about the services. Splitting that state per
 * pane would mean each one holding its own copy and the copies drifting; this
 * module keeps a single answer and no pane owns it.
 *
 * It imports nothing but types on purpose: it is the bottom of the graph, so
 * any pane may read it without creating a cycle.
 */
import type {
  LogListGroup,
  LogListItem,
  LogSource,
  LogsTarget,
  SilenceLevel,
} from '../../src/ipc-contract.js';

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

export interface LogsView {
  /** The single service on screen; null while a merged scope is shown. */
  processId: string | null;
  /** Current resolved target (group + command/action). */
  currentTarget: LogsTarget | null;
  /** groupId + commandId extracted from processId for silence ops. */
  currentGroupId: string | null;
  currentCommandId: string | null;
  /**
   * srcId → source while the window shows a merged stream; null in single
   * mode. Doubles as the "am I merged" flag.
   */
  groupSources: Map<string, LogSource> | null;
  /** Distinguishes the generic view from a single-group one; both are merged. */
  mergedIsAll: boolean;
  /** The merged scope on screen, so unknown sources can be looked up again. */
  mergedGroupId: string | null;
  /**
   * Levels the view is pinned to. Empty means "show everything"; otherwise
   * only lines of the selected levels survive. Combines with the text filter —
   * both must pass.
   */
  levelFilter: Set<SilenceLevel>;
  /** The compiled text filter, or null when the box is empty. */
  filterRe: RegExp | null;
  /**
   * Lines held in memory. Mirrors what ProcessManager actually keeps for the
   * target on screen — a number only main can give us, since a running process
   * froze its limit at start and a setting edited since does not apply to it.
   * Holding more than main does would let the viewer filter and copy lines the
   * process buffer has already dropped.
   */
  memoryCap: number;
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
  processId: null,
  currentTarget: null,
  currentGroupId: null,
  currentCommandId: null,
  groupSources: null,
  mergedIsAll: false,
  mergedGroupId: null,
  levelFilter: new Set<SilenceLevel>(),
  filterRe: null,
  memoryCap: 20_000,
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
