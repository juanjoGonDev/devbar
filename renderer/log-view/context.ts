/**
 * One log view: what it holds, how it is filtered, where it is looking, and
 * the elements it draws into.
 *
 * The logs window and the workflow terminal under the canvas are the same
 * engine — one buffer, one row builder, one live tail, one redraw rule — so
 * whatever one of them shows the other shows the same way. Each of them is an
 * instance: a context built once and handed to the pieces in this directory,
 * which keep nothing at module level. The window builds its context from its
 * own singletons (`renderer/logs/view.ts`, `buffer.ts`, `stack-fold.ts`) and
 * adds its chrome around it; the terminal builds a fresh one
 * (`createLogView`) and adds only its tabs.
 */
import type { LogEntry } from '../../src/domain-types.js';
import type { LogSource, SilenceLevel } from '../../src/ipc-contract.js';
import type { LogBuffer } from '../logs/buffer.js';
import type { StackIndex } from '../logs/stack-fold.js';
import type { FindCursor } from '../logs/find-model.js';
import type { PatternMatcher } from '../logs/silence-preview.js';
import {
  LIVE,
  nextLive,
  type LiveEvent,
  type LiveState,
} from '../logs/live-state.js';

/** A rule being previewed: which lines it swallows, and where it bites. */
interface SilencePreview {
  swallows(entry: LogEntry): boolean;
  matcher: PatternMatcher;
}

/** What the engine reads and writes about one view. */
export interface LogViewState {
  /** The single process on screen; null while a merged scope is shown. */
  processId: string | null;
  /**
   * srcId → source while the view shows a merged stream; null in single
   * mode. Doubles as the "am I merged" flag.
   */
  groupSources: Map<string, LogSource> | null;
  /** The merged scope on screen, so unknown sources can be looked up again. */
  mergedGroupId: string | null;
  /**
   * Levels the view is pinned to. Empty means "show everything"; otherwise
   * only lines of the selected levels survive. Combines with the text filter —
   * both must pass.
   */
  levelFilter: Set<SilenceLevel>;
  /**
   * What hides the lines that do not match: the find query while «Solo
   * coincidencias» is on, null otherwise. Non-global, so `test` keeps no state.
   */
  filterRe: RegExp | null;
  /** The find query, global, for marking its hits; null while nothing is searched. */
  findRe: RegExp | null;
  /** The hit the find widget is on, drawn brighter than the rest. */
  findCurrent: FindCursor | null;
  /**
   * Lines held in memory. Mirrors what ProcessManager actually keeps for the
   * target on screen — a number only main can give us, since a running process
   * froze its limit at start and a setting edited since does not apply to it.
   */
  memoryCap: number;
  /**
   * The rule the silenced popover is previewing. Rows it would swallow are
   * drawn marked, so a row built later is marked the same way.
   */
  silencePreview: SilencePreview | null;
  /** Following the tail, or paused — and why (see `live-state.ts`). */
  live: LiveState;
}

/** A fresh view: nothing held, nothing filtered, following the tail. */
export function createLogViewState(memoryCap = 20_000): LogViewState {
  return {
    processId: null,
    groupSources: null,
    mergedGroupId: null,
    levelFilter: new Set<SilenceLevel>(),
    filterRe: null,
    findRe: null,
    findCurrent: null,
    memoryCap,
    silencePreview: null,
    live: LIVE,
  };
}

/**
 * The find widget's side of the pane. A view without one hands in
 * `NO_FIND`: nothing is searched, so every hook is a no-op.
 */
export interface FindHooks {
  /** `visible` was rebuilt from scratch: count the matches again. */
  recount(): void;
  /** A line joined the end of `visible`. */
  appended(entryIndex: number): void;
  /** The `dropped` oldest entries left the buffer; `visible` kept its filters. */
  trimmed(dropped: number): void;
  /** «Ver en contexto» stopped hiding the lines that do not match. */
  filterDropped(): void;
  /** An entry point pinned a level: the chips saying so must be on screen. */
  levelPinned(): void;
}

export const NO_FIND: FindHooks = Object.freeze({
  recount: () => undefined,
  appended: () => undefined,
  trimmed: () => undefined,
  filterDropped: () => undefined,
  levelPinned: () => undefined,
});

/** Where a merged row's source tags lead; a view with no scopes has none. */
interface SourceNav {
  openScope(
    scope: { kind: 'group'; groupId: string },
    levels?: readonly SilenceLevel[],
  ): Promise<void>;
  jumpToLine(srcId: string, ts: number): Promise<void>;
}

export type LiveDispatch = (event: LiveEvent) => void;

/** Applies live events to `state`, calling `paint` only when it moved. */
export function liveDispatcher(
  state: { live: LiveState },
  paint?: () => void,
): LiveDispatch {
  return (event) => {
    const next = nextLive(state.live, event);
    if (next === state.live) return;
    state.live = next;
    paint?.();
  };
}

/** What a view's chrome repaints when the engine says so; all optional. */
interface LogViewHooks {
  /** What is held, filtered or counted changed. */
  counts?(tally: { warn: number; error: number; silenced: number }): void;
  /** The level pin changed. */
  levelFilter?(): void;
  /** What is selected may have changed. */
  selection?(): void;
}

export interface LogViewElements {
  /** Holds the rows. */
  lines: HTMLElement;
  /** Scrolls them. */
  main: HTMLElement;
  /** «Ir al final», shown while the view is not at the tail; optional. */
  scrollButton: HTMLElement | null;
}

export interface LogViewCtx {
  state: LogViewState;
  buffer: LogBuffer;
  stacks: StackIndex;
  /** Lines held back from the buffer while a manual pause is on. */
  pending: LogEntry[];
  dispatchLive: LiveDispatch;
  find: FindHooks;
  nav: SourceNav | null;
  /** How a row's clock reads; read per row, so a switch applies at once. */
  prefs: { readonly relativeTime: boolean };
  els: LogViewElements;
  hooks: LogViewHooks;
}
