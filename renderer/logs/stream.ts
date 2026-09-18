/**
 * The live stream, and the races it has with the snapshots that replace it.
 *
 * Two things arrive from main at once: a snapshot the window asked for, and
 * the lines that keep coming while it is in flight. Adopting the snapshot
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
 */
import { latestWins } from '../latest-wins.js';
import { queuedAfter } from '../pending-queue.js';
import { pushEntry } from './pane.js';
import { queueWhilePaused } from './status.js';
import { pausedEl } from './elements.js';
import { view } from './view.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SourcedLogEntry } from '../../src/ipc-contract.js';

/** Answers whether the load that took it is still the newest one. */
export type LoadTicket = () => boolean;

const loads = latestWins();

/** A live line held while a snapshot is in flight, with its source and place. */
interface HeldLine {
  id: string;
  entry: LogEntry;
  seq: number | undefined;
}

/** Lines that arrived while a snapshot was in flight; null when none is. */
let loadQueue: HeldLine[] | null = null;

/**
 * Lines whose source was unknown, waiting on the lookup that will name it.
 * Each is stamped with the scope it arrived in: a lookup that resolves after
 * the view moved on must not deliver another scope's lines.
 */
const unknownSourceQueue: { entry: SourcedLogEntry; current: LoadTicket }[] =
  [];
let refreshingSources = false;

/** Open a load: take the ticket and start holding what arrives meanwhile. */
export function beginLoad(): LoadTicket {
  // An orphan queue from an abandoned load goes: the snapshot we are about to
  // adopt covers everything it was holding.
  loadQueue = [];
  loads.invalidate();
  return loads.claim();
}

/**
 * Close a load: deliver what arrived while we waited, minus whatever the
 * snapshot already carried. `watermark` answers, per source, how far it got.
 */
export function endLoad(watermark: (id: string) => number): void {
  const held = loadQueue ?? [];
  loadQueue = null;
  for (const line of queuedAfter(held, (candidate) => watermark(candidate.id)))
    receiveLine(line.id, line.entry);
}

/**
 * Await a snapshot without risking a silent mute: if the request fails, the
 * lines held for it go back down the live path instead of sitting in a queue
 * nothing will ever drain.
 */
export async function awaitSnapshot<T>(
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

/** Held lines belong to the old scope; a scope switch drops them. */
export function dropUnknownSources(): void {
  unknownSourceQueue.length = 0;
}

/**
 * Refresh the merged source list after a line from a service we did not know
 * about. Guarded: a burst of lines from a new pre-script must not fire one
 * lookup each. The line that triggered it is dropped; the next one is tagged.
 */
async function learnSource(entry: SourcedLogEntry): Promise<void> {
  // Hold the line that triggered this, and any that arrive while the lookup is
  // in flight. Dropping them would lose a service that logs once and falls
  // quiet — and lose it from the filter and from copy too, not just the view.
  unknownSourceQueue.push({ entry, current: loads.claim() });
  if (refreshingSources || !view.groupSources) return;
  refreshingSources = true;
  try {
    for (;;) {
      const scope = loads.claim();
      const sources = await window.api.getMergedSources(view.mergedGroupId);
      if (!view.groupSources) return;
      if (scope()) {
        for (const source of sources) view.groupSources.set(source.id, source);
        break;
      }
      // The view moved on while we waited. These names belong to a scope that
      // is no longer on screen: writing them into the current map would label
      // live rows with another group's services. The lines they were fetched
      // for go with them — the new scope's snapshot supersedes that buffer.
      const waiting = unknownSourceQueue.filter((q) => q.current());
      unknownSourceQueue.length = 0;
      if (!waiting.length) return;
      unknownSourceQueue.push(...waiting); // arrived after the switch: still ours
    }
  } finally {
    refreshingSources = false;
  }
  const held = unknownSourceQueue.splice(0);
  for (const queued of held) {
    // Anything still unknown after a refresh really is not ours.
    if (queued.current() && view.groupSources?.has(queued.entry.srcId))
      deliverMerged(queued.entry);
  }
}

/** The paused-or-not path a merged line takes once its source is known. */
function deliverMerged(entry: SourcedLogEntry): void {
  if (pausedEl.checked) {
    queueWhilePaused(entry);
    return;
  }
  pushEntry(entry);
}

/** One live line, delivered the way the view on screen wants it. */
function receiveLine(id: string, entry: LogEntry): void {
  // In group mode any member's line belongs here; tag it with its source so
  // appendLine can label the row.
  if (view.groupSources) {
    // A service can appear AFTER the view opened — a pre-script running for
    // the first time. Main forwards it because the scope matches, so an
    // unknown id here means our source list is stale, not that the line is
    // foreign: learn the name, then show it.
    const sourced = { ...entry, srcId: id };
    if (!view.groupSources.has(id)) {
      void learnSource(sourced);
      return;
    }
    deliverMerged(sourced);
    return;
  }
  if (id !== view.processId) return;
  if (pausedEl.checked) {
    queueWhilePaused(entry);
    return;
  }
  pushEntry(entry);
}

/**
 * A line pushed from main. A snapshot in flight means delivering now would be
 * undone by the `resetBuffer` that adopts it, and this line is too new to be
 * in it: hold it and reconcile once we know where the snapshot ended.
 */
export function receivePush(payload: { id: string; entry: LogEntry }): void {
  if (loadQueue) {
    loadQueue.push({
      id: payload.id,
      entry: payload.entry,
      seq: payload.entry.seq,
    });
    return;
  }
  receiveLine(payload.id, payload.entry);
}
