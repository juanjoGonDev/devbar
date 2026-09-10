import type { Group, PreStep } from './domain-types.js';

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

/**
 * Groups eligible for legacy per-group auto-start: at least one `autoStart`
 * command. Actions are never eligible (running e.g. `pnpm install` at every
 * boot would be wrong) — extracted from `main.ts`'s inline filter so it is
 * provable without Electron (sdd-verify C6).
 */
export function filterAutoStartEligibleGroups(
  groups: readonly Group[],
): Group[] {
  return groups.filter((group) =>
    (group.commands || []).some((command) => command.autoStart === true),
  );
}

/**
 * Whether the ONE global pipeline should run at this boot. Deliberately has
 * NO knowledge of autoStart-eligible groups: the pipeline has value on its
 * own (a VPN tunnel, a `make setup` step) and must run whenever the login
 * gate passes, the global setting is on, and there is at least one step —
 * independent of whether any group has an autoStart command. This is the W2
 * fix (sdd-verify): the OLD `main.ts` code checked `eligibleGroups.length`
 * BEFORE this decision, so a pipeline never ran at login if no group had an
 * autoStart command at all. Command release still follows the per-group
 * staged rule above (`planAutoStartRelease`/`withheldGroupIds`).
 */
export function shouldAutoRunPipeline(input: {
  wasOpenedAtLogin: boolean;
  preScriptsAutoRun: boolean;
  stepCount: number;
}): boolean {
  return (
    input.wasOpenedAtLogin &&
    input.preScriptsAutoRun === true &&
    input.stepCount > 0
  );
}

export type WithheldReportCause = 'failure' | 'cancelled';

export interface WithheldReport {
  aggregatorLine: string;
  aggregatorLevel: 'warn' | 'error';
  toastKind: 'ok' | 'error';
  message: string;
}

/**
 * Pure message composition for `main.ts`'s `reportWithheldGroups`: names
 * every withheld group and picks wording/severity by cause. This is the
 * exact seam sdd-verify's C2 needed proof for: `withheldGroupIds` above has
 * no notion of "why" the run stopped, so a decline being reported as a
 * CANCELLATION rather than an ERROR is entirely this function's job.
 * Returns `null` when there is nothing to report.
 */
export function describeWithheldGroups(input: {
  withheldIds: readonly string[];
  groupsById: ReadonlyMap<string, { name: string }>;
  cause: WithheldReportCause;
}): WithheldReport | null {
  const { withheldIds, groupsById, cause } = input;
  if (withheldIds.length === 0) return null;
  const names = withheldIds
    .map((id) => groupsById.get(id)?.name ?? id)
    .join(', ');
  const aggregatorLine =
    cause === 'failure'
      ? `── Auto-start withheld for: ${names} (pipeline failed) ──`
      : `── Auto-start withheld for: ${names} (pipeline cancelled) ──`;
  return {
    aggregatorLine,
    aggregatorLevel: cause === 'failure' ? 'error' : 'warn',
    // A decline is a cancellation, never an error — 'ok' is the only styled
    // non-error toast kind this app has (styles.css .toast.ok/.toast.error).
    toastKind: cause === 'failure' ? 'error' : 'ok',
    message: `Auto-arranque retenido para: ${names}`,
  };
}
