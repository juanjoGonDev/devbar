/**
 * Pure list surgery over the global pre-script pipeline and over any
 * id-ordered CRUD list. No normalization, no persistence: each function takes
 * the current arrays and returns the next ones.
 */
import type { Group, PreStep, PreStepScriptRef } from '../domain-types.js';

/**
 * Referential-integrity pass for the global pipeline: drops any ref whose
 * group or script no longer exists. Mirrors `regenerateLegacyServices` —
 * called by the persist helper on every write, not bolted onto individual
 * delete call sites, so every future write path gets it for free (D5).
 *
 * A step that becomes empty is KEPT: it is a user-authored ordering slot,
 * and the editor already creates empty steps deliberately.
 */
export function prunePipelineRefs(
  steps: readonly PreStep[],
  groups: readonly Group[],
): PreStep[] {
  const scriptIdsByGroup = new Map<string, Set<string>>();
  for (const group of groups) {
    scriptIdsByGroup.set(
      group.id,
      new Set(group.preScripts.map((script) => script.id)),
    );
  }
  return steps.map((step) => ({
    ...step,
    scripts: step.scripts.filter((ref) =>
      Boolean(scriptIdsByGroup.get(ref.groupId)?.has(ref.scriptId)),
    ),
  }));
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

/**
 * Places `ref` into `stepId` at `position` (end of the step when omitted),
 * first removing it from EVERY step (including the target). This single
 * function covers a fresh placement, a cross-step move, and a same-step
 * reorder — all are just "this ref now lives at this position in this
 * step" — so the renderer's cross-container drag needs exactly one call.
 */
export function assignScriptToStep(
  steps: readonly PreStep[],
  stepId: string,
  ref: PreStepScriptRef,
  position?: number,
): PreStep[] {
  // A stale/unknown stepId must not silently unassign the ref: removing it
  // from wherever it currently lives, with no matching step to re-insert it
  // into, would leave it placed nowhere — and `config-store` persists
  // whatever this function returns.
  if (!steps.some((step) => step.id === stepId)) return [...steps];
  const isSameRef = (candidate: PreStepScriptRef): boolean =>
    candidate.groupId === ref.groupId && candidate.scriptId === ref.scriptId;
  const withoutRefAnywhere = steps.map((step) => ({
    ...step,
    scripts: step.scripts.filter((existing) => !isSameRef(existing)),
  }));
  return withoutRefAnywhere.map((step) => {
    if (step.id !== stepId) return step;
    const insertAt =
      position === undefined
        ? step.scripts.length
        : Math.max(0, Math.min(position, step.scripts.length));
    return {
      ...step,
      scripts: [
        ...step.scripts.slice(0, insertAt),
        ref,
        ...step.scripts.slice(insertAt),
      ],
    };
  });
}

/** Removes `ref` from `stepId` only, leaving every other step untouched. */
export function unassignScriptFromStep(
  steps: readonly PreStep[],
  stepId: string,
  ref: PreStepScriptRef,
): PreStep[] {
  return steps.map((step) => {
    if (step.id !== stepId) return step;
    return {
      ...step,
      scripts: step.scripts.filter(
        (existing) =>
          !(
            existing.groupId === ref.groupId &&
            existing.scriptId === ref.scriptId
          ),
      ),
    };
  });
}
