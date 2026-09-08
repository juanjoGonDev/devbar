import type { LogEntry } from './domain-types.js';
import type { SourcedLogEntry } from './ipc-contract.js';

export interface SourceBuffer {
  srcId: string;
  entries: readonly LogEntry[];
}

/**
 * Newest `limit` entries across several log buffers, oldest-first, each tagged
 * with the source it came from.
 *
 * Each buffer is append-only and therefore already ascending by timestamp, so
 * this walks all of them backwards at once and takes the newest head each step
 * — a k-way merge that stops as soon as it has `limit` entries.
 *
 * The obvious alternative (concatenate every buffer, sort, keep the tail) costs
 * S × L clones and a sort of the same, on the main thread: with 20 services and
 * a 20 000-line retention that is 400 000 objects to build and order in a
 * process that also has to answer IPC and paint the tray. This clones at most
 * `limit` and never sorts.
 *
 * Comparisons are O(limit × S), which is fine while S is a handful of services;
 * a heap would only pay off with far more sources than a menubar app has.
 */
export function mergeNewestByTs(
  buffers: readonly SourceBuffer[],
  limit: number,
): SourcedLogEntry[] {
  if (limit <= 0) return [];
  // One cursor per buffer, starting at its newest entry.
  const cursors = buffers.map((buffer) => buffer.entries.length - 1);
  const out: SourcedLogEntry[] = [];

  while (out.length < limit) {
    let pick = -1;
    let pickTs = 0;
    for (let index = 0; index < buffers.length; index += 1) {
      const cursor = cursors[index];
      if (cursor === undefined || cursor < 0) continue;
      const entry = buffers[index]?.entries[cursor];
      if (!entry) continue;
      if (pick === -1 || entry.ts > pickTs) {
        pick = index;
        pickTs = entry.ts;
      }
    }
    if (pick === -1) break; // every buffer exhausted
    const cursor = cursors[pick];
    const buffer = buffers[pick];
    if (cursor === undefined || !buffer) break;
    const entry = buffer.entries[cursor];
    if (entry) out.push({ ...entry, srcId: buffer.srcId });
    cursors[pick] = cursor - 1;
  }

  // Collected newest-first; callers render oldest-first.
  out.reverse();
  return out;
}
