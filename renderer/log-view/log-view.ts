/**
 * A log view of its own, for a screen that is not the logs window: the
 * workflow terminal under the canvas.
 *
 * It is the logs window's engine — the same pane, rows, live tail, redraws
 * and snapshot/stream reconciliation — in a fresh context, fed the same way:
 * `getLogs` (`logs:get`) for the snapshot, which also points main's live
 * stream at it, then `logs:line` pushes through `receivePush`. What it adds
 * is only `open`, the single-process load the logs window's scope switcher
 * does with its own chrome around it (`renderer/logs/scope.ts`).
 */
import { createBuffer, type LogBuffer } from '../logs/buffer.js';
import { createStackIndex } from '../logs/stack-fold.js';
import {
  NO_FIND,
  createLogViewState,
  liveDispatcher,
  type LogViewCtx,
  type LogViewElements,
  type LogViewState,
} from './context.js';
import { createPane } from './pane.js';
import { createPendingLines } from './pending.js';
import { createStream } from './stream.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { LogsSnapshot } from '../../src/ipc-contract.js';

export interface LogView {
  readonly state: LogViewState;
  readonly buffer: LogBuffer;
  /**
   * Show one process's log: its snapshot now, its live lines after. Opening
   * the process already shown reloads it in place — a new run of it emptied
   * main's buffer. False when a newer `open` or a `clear` won meanwhile, or
   * the snapshot could not be read.
   */
  open(processId: string): Promise<boolean>;
  /** Show nothing, and give up any load in flight. */
  clear(): void;
  /** A line main pushed (`logs:line`); one for another process is ignored. */
  receivePush(payload: { id: string; entry: LogEntry }): void;
}

export function createLogView(els: LogViewElements): LogView {
  const state = createLogViewState();
  const pending: LogEntry[] = [];
  const ctx: LogViewCtx = {
    state,
    buffer: createBuffer(),
    stacks: createStackIndex(),
    pending,
    dispatchLive: liveDispatcher(state),
    find: NO_FIND,
    nav: null,
    // No clock switch of its own: the absolute time, as the window's default.
    prefs: { relativeTime: false },
    els,
    hooks: {},
  };
  const pane = createPane(ctx);
  const queue = createPendingLines(ctx);
  const stream = createStream({
    state,
    pushEntry: pane.pushEntry,
    queueWhilePaused: queue.queueWhilePaused,
    // Only the logs window shows merged scopes.
    mergedSources: () => Promise.resolve([]),
  });

  async function open(processId: string): Promise<boolean> {
    if (state.processId !== processId) {
      state.processId = processId;
      pane.resetBuffer([]);
      queue.dropPendingQueue();
    }
    // getLogs also points main's live stream at this view, atomically.
    const token = stream.beginLoad();
    let res: LogsSnapshot;
    try {
      res = await stream.awaitSnapshot(window.api.getLogs(processId), token);
    } catch {
      return false; // nothing to adopt; what it held went back to the live path
    }
    if (!token() || state.processId !== processId) return false;
    state.memoryCap = res.logLimit; // what main kept for it, not what config says
    queue.keepQueuedAfter(() => res.seq); // held by a pause from before
    pane.resetBuffer([...res.lines]);
    stream.endLoad(() => res.seq); // arrived while it was in flight
    return true;
  }

  return {
    state,
    buffer: ctx.buffer,
    open,
    clear() {
      state.processId = null;
      stream.cancelLoad();
      pane.resetBuffer([]);
      queue.dropPendingQueue();
    },
    receivePush: stream.receivePush,
  };
}
