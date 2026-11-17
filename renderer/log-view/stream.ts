/**
 * A view's live stream, and the races it has with the snapshots that replace
 * it.
 *
 * Two things arrive from main at once: a snapshot the view asked for, and the
 * lines that keep coming while it is in flight. Adopting the snapshot
 * replaces the buffer wholesale, so a line delivered during the wait would be
 * erased by it — and being newer than the snapshot, it is not in there either.
 * Every load therefore takes a ticket: lines that arrive meanwhile are held,
 * and reconciled against how far the snapshot actually got.
 *
 * The ticket is `latestWins`, the same guard the sidebar read uses. Identity
 * alone is not enough to detect a lost race — two overlapping loads of the
 * SAME scope would both pass an identity check and each append its own
 * snapshot, duplicating the history — so what a ticket answers is "is this
 * still the newest load?", which a superseded one answers with no.
 *
 * One stream per view (`createStream`): the logs window and the workflow
 * terminal reconcile their snapshots with the same code, each with its own
 * queue and tickets.
 */
import { latestWins } from '../latest-wins.js';
import { queuedAfter } from '../pending-queue.js';
import { isHolding } from '../logs/live-state.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { LogSource, SourcedLogEntry } from '../../src/ipc-contract.js';
import type { LogViewState } from './context.js';

/** How long a failed source lookup waits before it tries again. */
export const SOURCE_RETRY_MS = 1000;

/** Answers whether the load that took it is still the newest one. */
type LoadTicket = () => boolean;

/** A live line held while a snapshot is in flight, with its source and place. */
interface HeldLine {
  id: string;
  entry: LogEntry;
  seq: number | undefined;
}

export interface StreamDeps {
  state: LogViewState;
  pushEntry(entry: LogEntry): void;
  queueWhilePaused(entry: LogEntry): void;
  /** The sources of a merged scope, for a line from one the view did not know. */
  mergedSources(groupId: string | null): Promise<LogSource[]>;
}

export interface LogStream {
  /**
   * Open a load: take the ticket and start holding what arrives meanwhile.
   * `sameScope`: it reloads the scope a load in flight is still reading, so
   * it takes over what that load held, and the lines a source lookup still
   * holds — its snapshot drops what it covers, and a failed one hands it
   * back to the live path. A load of another scope starts empty: those
   * lines are not its own.
   */
  beginLoad: (sameScope?: boolean) => LoadTicket;
  /**
   * Close a load: deliver what arrived while we waited, minus whatever the
   * snapshot already carried. `watermark` answers, per source, how far it got.
   */
  endLoad: (watermark: (id: string) => number) => void;
  /**
   * Await a snapshot without risking a silent mute: if the request fails, the
   * lines held for it go back down the live path instead of sitting in a
   * queue nothing will ever drain.
   */
  awaitSnapshot: <T>(request: Promise<T>, token: LoadTicket) => Promise<T>;
  /** Give up the load in flight: its snapshot, and what it held, are moot. */
  cancelLoad: () => void;
  /** Held lines belong to the old scope; a scope switch drops them. */
  dropUnknownSources: () => void;
  /**
   * A line pushed from main. A snapshot in flight means delivering now would
   * be undone by the reset that adopts it, and this line is too new to be in
   * it: hold it and reconcile once we know where the snapshot ended.
   */
  receivePush: (payload: { id: string; entry: LogEntry }) => void;
}

export function createStream(deps: StreamDeps): LogStream {
  const { state: view } = deps;
  const loads = latestWins();
  /** Lines that arrived while a snapshot was in flight; null when none is. */
  let loadQueue: HeldLine[] | null = null;
  /**
   * Lines whose source was unknown, waiting on the lookup that will name it.
   * Each is stamped with the scope it arrived in: a lookup that resolves
   * after the view moved on must not deliver another scope's lines.
   */
  const unknownSourceQueue: {
    entry: SourcedLogEntry;
    current: LoadTicket;
  }[] = [];
  let refreshingSources = false;
  let sourceRetry: ReturnType<typeof setTimeout> | undefined;

  function beginLoad(sameScope = false): LoadTicket {
    // The snapshot about to be adopted covers everything a superseded load
    // was holding — if it arrives. Only a reload of the same scope keeps
    // them, for the case it does not; another scope's are not ours. The
    // lines waiting on a source lookup join them, older than anything held:
    // the ticket this retires is the lookup's too, so a reload that left
    // them there would lose them if its snapshot never came.
    loadQueue = sameScope
      ? [
          ...unknownSourceQueue.splice(0).map(({ entry }) => ({
            id: entry.srcId,
            entry,
            seq: entry.seq,
          })),
          ...(loadQueue ?? []),
        ]
      : [];
    loads.invalidate();
    return loads.claim();
  }

  function endLoad(watermark: (id: string) => number): void {
    const held = loadQueue ?? [];
    loadQueue = null;
    for (const line of queuedAfter(held, (candidate) =>
      watermark(candidate.id),
    ))
      receiveLine(line.id, line.entry);
  }

  async function awaitSnapshot<T>(
    request: Promise<T>,
    token: LoadTicket,
  ): Promise<T> {
    try {
      return await request;
    } catch (error) {
      if (token()) endLoad(() => 0);
      throw error;
    }
  }

  /**
   * Refresh the merged source list after a line from a service we did not
   * know about. Guarded: a burst of lines from a new pre-script must not fire
   * one lookup each.
   */
  function learnSource(entry: SourcedLogEntry): void {
    // Hold the line that triggered this, and any that arrive while the lookup
    // is in flight. Dropping them would lose a service that logs once and
    // falls quiet — and lose it from the filter and from copy too.
    unknownSourceQueue.push({ entry, current: loads.claim() });
    void refreshSources();
  }

  /**
   * Look the merged sources up for the lines `learnSource` holds. A failed
   * lookup keeps them and tries again on its own: the service that sent them
   * may never log again to trigger another one.
   */
  async function refreshSources(): Promise<void> {
    if (refreshingSources || !view.groupSources) return;
    refreshingSources = true;
    try {
      for (;;) {
        const scope = loads.claim();
        const sources = await deps.mergedSources(view.mergedGroupId);
        if (!view.groupSources) return;
        if (scope()) {
          for (const source of sources)
            view.groupSources.set(source.id, source);
          break;
        }
        // The view moved on while we waited. These names belong to a scope
        // that is no longer on screen: writing them into the current map
        // would label live rows with another group's services. The lines they
        // were fetched for go with them — the new scope's snapshot supersedes
        // that buffer. (A reload of this scope took them into its load.)
        const waiting = unknownSourceQueue.filter((q) => q.current());
        unknownSourceQueue.length = 0;
        if (!waiting.length) return;
        unknownSourceQueue.push(...waiting); // arrived after the switch: still ours
      }
    } catch {
      // ponytail: fixed delay, no backoff; a lookup that keeps failing means
      // main is gone, and a retry a second costs nothing until then.
      clearTimeout(sourceRetry);
      sourceRetry = setTimeout(() => {
        if (unknownSourceQueue.some((queued) => queued.current()))
          void refreshSources();
      }, SOURCE_RETRY_MS);
      return;
    } finally {
      refreshingSources = false;
    }
    const held = unknownSourceQueue.splice(0);
    for (const queued of held) {
      // Anything still unknown after a refresh really is not ours.
      if (queued.current() && view.groupSources?.has(queued.entry.srcId))
        deliver(queued.entry);
    }
  }

  /** The paused-or-not path a line takes once it is known to be ours. */
  function deliver(entry: LogEntry): void {
    if (isHolding(view.live)) {
      deps.queueWhilePaused(entry);
      return;
    }
    deps.pushEntry(entry);
  }

  /** One live line, delivered the way the view on screen wants it. */
  function receiveLine(id: string, entry: LogEntry): void {
    // In group mode any member's line belongs here; tag it with its source so
    // the row can be labelled.
    if (view.groupSources) {
      // A service can appear AFTER the view opened — a pre-script running for
      // the first time. Main forwards it because the scope matches, so an
      // unknown id here means our source list is stale, not that the line is
      // foreign: learn the name, then show it.
      const sourced = { ...entry, srcId: id };
      if (!view.groupSources.has(id)) {
        learnSource(sourced);
        return;
      }
      deliver(sourced);
      return;
    }
    if (id !== view.processId) return;
    deliver(entry);
  }

  return {
    beginLoad,
    endLoad,
    awaitSnapshot,
    cancelLoad: () => {
      loadQueue = null;
      loads.invalidate();
    },
    dropUnknownSources: () => {
      unknownSourceQueue.length = 0;
    },
    receivePush(payload) {
      if (loadQueue) {
        loadQueue.push({
          id: payload.id,
          entry: payload.entry,
          seq: payload.entry.seq,
        });
        return;
      }
      receiveLine(payload.id, payload.entry);
    },
  };
}
