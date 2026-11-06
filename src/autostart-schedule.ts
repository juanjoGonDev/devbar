import type { Group, Pipeline } from './domain-types.js';
import { runnableBlocks } from './pipeline-graph.js';

/**
 * Pure release planner for staged login auto-start (D2). Kept free of
 * Electron/runner concerns on purpose: `main.ts` is Electron-bound and
 * untestable directly, so every assertion about the boot-time scheduling
 * algorithm lives here instead.
 */
export interface AutoStartPlan {
  /** Eligible groups with no ref in any runnable block — start right away. */
  immediate: string[];
  /**
   * groupId → the blocks that must ALL complete successfully before that
   * group's autoStart commands start, in `eligibleGroupIds` order.
   */
  awaiting: Map<string, string[]>;
}

/**
 * A group's NATURAL release point is the moment every runnable block holding
 * one of its scripts has completed — in a DAG there is no "last step", and
 * the group's own blocks may sit on different branches. A ref in a block
 * that never runs (disconnected) does not count, so a group placed only
 * there starts immediately, like a group with no ref at all.
 *
 * `waitingGroupIds` (per-group `Group.waitForPipeline`, default `true`)
 * overrides that natural point for a group WITH at least one runnable ref:
 * it waits for EVERY runnable block, i.e. for the whole pipeline to succeed.
 * This closes a real defect found in production use — a group's own block
 * can succeed while another block belonging to a completely different group
 * still disrupts shared infrastructure (e.g. a second `make setup`
 * restarting Docker after the first group already came up and connected to
 * it). A group with no runnable ref is unaffected by `waitingGroupIds` and
 * still starts immediately — waiting only makes sense relative to a block
 * this group actually participates in.
 *
 * Both outputs follow `eligibleGroupIds` order, never the pipeline's, so
 * assertions on the result stay deterministic however it was authored.
 */
export function planAutoStartRelease(input: {
  pipeline: Pipeline;
  eligibleGroupIds: readonly string[];
  waitingGroupIds?: readonly string[];
}): AutoStartPlan {
  const { pipeline, eligibleGroupIds } = input;
  const waiting = new Set(input.waitingGroupIds ?? []);
  const runnable = runnableBlocks(pipeline);
  const runnableSet = new Set(runnable);
  const ownBlocks = new Map<string, string[]>();
  for (const block of pipeline.blocks) {
    if (!runnableSet.has(block.id)) continue;
    for (const ref of block.scripts) {
      const list = ownBlocks.get(ref.groupId) ?? [];
      if (!list.includes(block.id)) list.push(block.id);
      ownBlocks.set(ref.groupId, list);
    }
  }
  const immediate: string[] = [];
  const awaiting = new Map<string, string[]>();
  for (const groupId of eligibleGroupIds) {
    const own = ownBlocks.get(groupId);
    if (!own) immediate.push(groupId);
    else awaiting.set(groupId, waiting.has(groupId) ? [...runnable] : own);
  }
  return { immediate, awaiting };
}

/** Awaiting groups every block of which is in `completed`, in plan order. */
export function releasableGroupIds(
  plan: AutoStartPlan,
  completed: ReadonlySet<string>,
): string[] {
  return [...plan.awaiting]
    .filter(([, blocks]) => blocks.every((id) => completed.has(id)))
    .map(([groupId]) => groupId);
}

/**
 * Groups whose release never came — a genuine failure or a declined
 * confirmation both withhold identically at the same frozen `completed`
 * set (the decided override: one release rule, not two).
 */
export function withheldGroupIds(
  plan: AutoStartPlan,
  completed: ReadonlySet<string>,
): string[] {
  return [...plan.awaiting]
    .filter(([, blocks]) => !blocks.every((id) => completed.has(id)))
    .map(([groupId]) => groupId);
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
 * Whether the startup workflow should run at this boot. Deliberately has
 * NO knowledge of autoStart-eligible groups: the workflow has value on its
 * own (a VPN tunnel, a `make setup` block) and must run whenever the login
 * gate passes, the workflow is enabled («Auto al arrancar»), and there is at
 * least one runnable script —
 * independent of whether any group has an autoStart command. This is the W2
 * fix (sdd-verify): the OLD `main.ts` code checked `eligibleGroups.length`
 * BEFORE this decision, so a pipeline never ran at login if no group had an
 * autoStart command at all. Command release still follows the per-group
 * staged rule above (`planAutoStartRelease`/`withheldGroupIds`).
 */
export function shouldAutoRunPipeline(input: {
  wasOpenedAtLogin: boolean;
  /** The startup workflow's `enabled`. */
  startupEnabled: boolean;
  /** Scripts in runnable blocks (`runnableScriptCount`). */
  scriptCount: number;
}): boolean {
  return (
    input.wasOpenedAtLogin &&
    input.startupEnabled === true &&
    input.scriptCount > 0
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
      ? `── Auto-arranque retenido para: ${names} (workflow de arranque fallido) ──`
      : `── Auto-arranque retenido para: ${names} (workflow de arranque cancelado) ──`;
  return {
    aggregatorLine,
    aggregatorLevel: cause === 'failure' ? 'error' : 'warn',
    // A decline is a cancellation, never an error — 'ok' is the only styled
    // non-error toast kind this app has (styles.css .toast.ok/.toast.error).
    toastKind: cause === 'failure' ? 'error' : 'ok',
    message: `Auto-arranque retenido para: ${names}`,
  };
}

/**
 * Whether the runner's own generic per-failure toast should still fire,
 * given whether this failure happened during a boot auto-start run and how
 * many groups that run withholds (sdd-verify W5: a genuine pipeline failure
 * fired two error toasts — this one, then a second, more informative one
 * naming the withheld groups via `describeWithheldGroups`). A boot run that
 * withholds at least one group gets its failure reported by that more
 * informative toast instead, so the generic one would only duplicate it. A
 * manual (non-boot) run, or a boot run that withholds nothing, has no other
 * message coming and still needs this one as its only feedback.
 */
export function shouldShowGenericFailureToast(input: {
  isBootRun: boolean;
  withheldCount: number;
}): boolean {
  return !input.isBootRun || input.withheldCount === 0;
}
