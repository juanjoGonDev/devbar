/**
 * Pure surgery over the global pre-script pipeline and over any id-ordered
 * CRUD list. No normalization, no persistence: each function takes
 * the current arrays and returns the next ones.
 */
import type { Group, Pipeline } from '../domain-types.js';
import { pruneRefs } from '../pipeline-graph.js';

/**
 * Referential-integrity pass for the global pipeline: drops any ref whose
 * group or script no longer exists. Mirrors `regenerateLegacyServices` —
 * called by the persist helper on every write, not bolted onto individual
 * delete call sites, so every future write path gets it for free (D5).
 *
 * A block that becomes empty is removed and its sources are wired straight
 * to its targets (`pruneRefs`), so deleting a script never silently stops
 * the blocks after it from running.
 */
export function prunePipelineRefs(
  pipeline: Pipeline,
  groups: readonly Group[],
): Pipeline {
  const scriptIdsByGroup = new Map<string, Set<string>>();
  for (const group of groups) {
    scriptIdsByGroup.set(
      group.id,
      new Set(group.preScripts.map((script) => script.id)),
    );
  }
  return pruneRefs(pipeline, (ref) =>
    Boolean(scriptIdsByGroup.get(ref.groupId)?.has(ref.scriptId)),
  );
}

/**
 * Reorders `items` to match `orderedIds`: known ids come first, in that
 * exact order (a repeated id only counts once); any item whose id is not in
 * `orderedIds` is appended afterward, in its original relative order.
 * Shared by every id-ordered CRUD list in `config-store.ts` — groups,
 * commands, actions, pre-steps, and pre-scripts all reorder the same way
 * (sdd-verify W3: previously a private helper there, and hand-copied again
 * inside a test file since `config-store.ts` cannot be imported under
 * Vitest; now real and imported by both).
 */
export function reorderByIds<T extends { id: string }>(
  items: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const sorted: T[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      sorted.push(item);
      seen.add(id);
    }
  }
  for (const item of items) if (!seen.has(item.id)) sorted.push(item);
  return sorted;
}
