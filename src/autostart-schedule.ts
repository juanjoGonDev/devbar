import type { PreStep } from './domain-types.js';

/**
 * Pure release planner for staged login auto-start (D2). Kept free of
 * Electron/runner concerns on purpose: `main.ts` is Electron-bound and
 * untestable directly, so every assertion about the boot-time scheduling
 * algorithm lives here instead.
 */
export interface AutoStartPlan {
  /** Eligible groups with no ref anywhere in the pipeline — start right away. */
  immediate: string[];
  /** stepIndex (0-based) -> eligible groups whose LAST referencing step is this one. */
  releases: Map<number, string[]>;
}

/**
 * Walks `steps` in order; for each ref whose `groupId` is eligible, the
 * ref's step index overwrites any earlier one recorded for that group
 * (later wins) — so a group's release point is always its LAST referencing
 * step. Both output lists are emitted in `eligibleGroupIds` input order,
 * never steps-walk insertion order, so assertions on the result stay
 * deterministic regardless of how the pipeline happens to be authored.
 */
export function planAutoStartRelease(input: {
  steps: readonly PreStep[];
  eligibleGroupIds: readonly string[];
}): AutoStartPlan {
  const { steps, eligibleGroupIds } = input;
  const eligible = new Set(eligibleGroupIds);
  const lastStepIndexByGroup = new Map<string, number>();
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (!step) continue;
    for (const scriptRef of step.scripts) {
      if (eligible.has(scriptRef.groupId)) {
        lastStepIndexByGroup.set(scriptRef.groupId, stepIndex);
      }
    }
  }

  const immediate: string[] = [];
  const releases = new Map<number, string[]>();
  for (const groupId of eligibleGroupIds) {
    const releaseStepIndex = lastStepIndexByGroup.get(groupId);
    if (releaseStepIndex === undefined) {
      immediate.push(groupId);
      continue;
    }
    const group = releases.get(releaseStepIndex);
    if (group) group.push(groupId);
    else releases.set(releaseStepIndex, [groupId]);
  }
  return { immediate, releases };
}

/**
 * Groups whose release step never fired — a genuine failure or a declined
 * confirmation both withhold identically at the same frozen `firedStepIndexes`
 * set (the decided override: one release rule, not two — see the Decided
 * Override note in the tasks artifact).
 */
export function withheldGroupIds(
  plan: AutoStartPlan,
  firedStepIndexes: ReadonlySet<number>,
): string[] {
  const withheld: string[] = [];
  const stepIndexes = [...plan.releases.keys()].sort((a, b) => a - b);
  for (const stepIndex of stepIndexes) {
    if (firedStepIndexes.has(stepIndex)) continue;
    withheld.push(...(plan.releases.get(stepIndex) ?? []));
  }
  return withheld;
}
