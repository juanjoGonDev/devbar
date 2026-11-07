import { makeCommandId } from '../compound-id.js';
import {
  describeWithheldGroups,
  filterAutoStartEligibleGroups,
  planAutoStartRelease,
  releasableGroupIds,
  shouldAutoRunPipeline,
  shouldShowGenericFailureToast,
  withheldGroupIds,
  type AutoStartPlan,
} from '../autostart-schedule.js';
import type { Group, LogEntry, Workflow } from '../domain-types.js';
import { runnableScriptCount } from '../pipeline-graph.js';
import type { RunResult } from '../pre-script-runner.js';
import { startupWorkflow } from '../workflows.js';

/**
 * Everything that happens once, at launch: restoring the previous session's
 * services, and running the startup workflow («workflow de arranque») before
 * releasing each eligible group's `autoStart` commands.
 *
 * The staged-release bookkeeping lives here rather than in `main.ts` because
 * it is shared state read from THREE places — the boot flow itself, the
 * runner's `onBlockComplete`, and its `onError` — and getting it wrong starves
 * a group that should have started.
 */

interface StartupProcessManager {
  resolveTarget: (processId: string) => {
    kind: 'command' | 'action' | 'prescript';
    target: { command?: string | undefined; confirm?: boolean | undefined };
  } | null;
  start: (processId: string) => { ok: boolean; error?: string | undefined };
  pushLog: (id: string, entry: LogEntry) => void;
}

interface StartupConfigStore {
  listGroups: () => Group[];
  listWorkflows: () => Workflow[];
}

export interface StartupDeps {
  processManager: StartupProcessManager;
  configStore: StartupConfigStore;
  workflowRunner: {
    run: (workflowId: string, cause: 'startup') => Promise<RunResult>;
    current: (workflowId: string) => Promise<RunResult> | null;
  };
  /** Consumes (and deletes) the previous session's snapshot. */
  consumeSnapshot: (canResume: (id: string) => boolean) => {
    resume: string[];
    reason: string;
  };
  broadcastToast: (kind: string, message: string) => void;
  showCompletionNotification: (title: string, body: string) => void;
  /** Per-platform "was this launch the OS login one" (pre-script gate). */
  wasOpenedAtLogin: () => boolean;
  /** DEVBAR_FORCE_LOGIN=1 — test the boot auto-run flow without rebooting. */
  forceLogin: boolean;
}

export interface Startup {
  resumeSavedServices: () => void;
  autoStartAllMarkedCommands: () => Promise<void>;
  startGroupAutoStartCommands: (group: Group) => void;
  /** Releases the groups whose every awaited block has now completed. */
  onWorkflowBlockComplete: (event: {
    workflowId: string;
    blockId: string;
  }) => void;
  /** Whether the runner's generic failure toast would say anything new. */
  shouldShowGenericFailureToast: () => boolean;
}

export function createStartup(deps: StartupDeps): Startup {
  const { processManager, configStore, workflowRunner } = deps;

  // Set only while `autoStartAllMarkedCommands` awaits the BOOT-time run of
  // the startup workflow. Null the rest of the time — including during a
  // manual, tray-triggered run — because releasing autoStart commands is
  // exclusively a boot concern.
  let activeAutoStartRelease: {
    /** The startup workflow whose blocks release the groups. */
    workflowId: string;
    plan: AutoStartPlan;
    groupsById: ReadonlyMap<string, Group>;
    /** Blocks that completed successfully during this boot run. */
    completed: Set<string>;
    /** Awaiting groups already started — each starts at most once. */
    started: Set<string>;
  } | null = null;

  function startGroupAutoStartCommands(group: Group): void {
    const eligible = (group.commands || []).filter(
      (cmd) => cmd.autoStart === true,
    );
    const toStart = group.mode === 'single' ? eligible.slice(0, 1) : eligible;
    for (const cmd of toStart) {
      const pid = makeCommandId(group.id, cmd.id);
      try {
        processManager.start(pid);
      } catch (err) {
        console.error(`autoStart failed for ${group.name}/${cmd.name}:`, err);
      }
    }
  }

  /**
   * Names every group withheld by a startup workflow failure or a declined
   * confirmation. Same computation, same reporting machinery for both causes
   * (the Decided Override: one release rule) — the wording/severity split is
   * `describeWithheldGroups`'s job; this is only the IO side effect.
   */
  function reportWithheldGroups(
    withheldIds: readonly string[],
    groupsById: ReadonlyMap<string, Group>,
    aggregatorId: string | null,
    cause: 'failure' | 'cancelled',
  ): void {
    const report = describeWithheldGroups({ withheldIds, groupsById, cause });
    if (!report) return;
    if (aggregatorId) {
      processManager.pushLog(aggregatorId, {
        ts: Date.now(),
        stream: 'sys',
        level: report.aggregatorLevel,
        line: report.aggregatorLine,
      });
    }
    deps.broadcastToast(report.toastKind, report.message);
    deps.showCompletionNotification('DevBar — workflows', report.message);
  }

  return {
    /**
     * Consume the previous session's snapshot and restart what it says was
     * running. Only commands that are still configured, still have a command,
     * and are NOT confirm-gated are started — an unattended launch must never
     * bypass a confirmation gate.
     */
    resumeSavedServices(): void {
      const canResume = (id: string): boolean => {
        const resolved = processManager.resolveTarget(id);
        if (!resolved || resolved.kind !== 'command') return false;
        if (!resolved.target.command || !resolved.target.command.trim())
          return false;
        return !resolved.target.confirm;
      };
      const decision = deps.consumeSnapshot(canResume);
      if (decision.resume.length === 0) return;
      let started = 0;
      for (const id of decision.resume) {
        const result = processManager.start(id);
        if (result.ok) started++;
        else console.warn(`[resume] ${id}: ${result.error ?? 'start failed'}`);
      }
      console.log(
        `[resume] ${started}/${decision.resume.length} services restored (reason: ${decision.reason})`,
      );
      // No window may exist yet (tray app) — then this is a harmless no-op.
      deps.broadcastToast(
        'ok',
        started === decision.resume.length
          ? `Servicios restaurados: ${started}`
          : `Servicios restaurados: ${started} de ${decision.resume.length}`,
      );
    },

    startGroupAutoStartCommands,

    onWorkflowBlockComplete({ workflowId, blockId }): void {
      const active = activeAutoStartRelease;
      if (!active || active.workflowId !== workflowId) return;
      active.completed.add(blockId);
      for (const groupId of releasableGroupIds(active.plan, active.completed)) {
        if (active.started.has(groupId)) continue;
        active.started.add(groupId);
        const group = active.groupsById.get(groupId);
        if (group) startGroupAutoStartCommands(group);
      }
    },

    /**
     * During a boot auto-start run, a more informative toast naming the
     * withheld groups follows right after `run()` resolves, so the generic one
     * would only duplicate it. A manual (non-boot) run, or a boot run that
     * withholds nothing, has no other message coming.
     */
    shouldShowGenericFailureToast(): boolean {
      const active = activeAutoStartRelease;
      return shouldShowGenericFailureToast({
        isBootRun: active !== null,
        withheldCount: active
          ? withheldGroupIds(active.plan, active.completed).length
          : 0,
      });
    },

    async autoStartAllMarkedCommands(): Promise<void> {
      // Only run pre-scripts when DevBar was launched by the OS at login — not
      // on every manual app restart. This protects the user from re-running
      // expensive `make setup` style scripts every time they reopen DevBar.
      const openedAtLogin = deps.forceLogin || deps.wasOpenedAtLogin();
      const workflow = startupWorkflow(configStore.listWorkflows());
      const pipeline = workflow?.graph ?? { blocks: [], edges: [] };
      const shouldRunPipeline =
        workflow !== null &&
        shouldAutoRunPipeline({
          wasOpenedAtLogin: openedAtLogin,
          startupEnabled: workflow.enabled,
          scriptCount: runnableScriptCount(pipeline),
        });

      // Deliberately computed AFTER the startup workflow decision above, and
      // NOT used to gate it: a workflow with real blocks must run at login
      // even when no group has an autoStart command at all.
      const eligibleGroups = filterAutoStartEligibleGroups(
        configStore.listGroups(),
      );

      if (!workflow || !shouldRunPipeline) {
        for (const group of eligibleGroups) startGroupAutoStartCommands(group);
        return;
      }

      const groupsById = new Map(
        eligibleGroups.map((group) => [group.id, group]),
      );
      const plan = planAutoStartRelease({
        pipeline,
        eligibleGroupIds: eligibleGroups.map((group) => group.id),
        // Group.waitForPipeline (default true): a group whose own blocks
        // already succeeded can still get broken by another, unrelated group's
        // block (e.g. a second `make setup` restarting Docker) — so by default
        // every eligible group waits for the whole pipeline instead of
        // releasing early.
        waitingGroupIds: eligibleGroups
          .filter((group) => group.waitForPipeline)
          .map((group) => group.id),
      });
      for (const groupId of plan.immediate) {
        const group = groupsById.get(groupId);
        if (group) startGroupAutoStartCommands(group);
      }

      const release = {
        workflowId: workflow.id,
        plan,
        groupsById,
        completed: new Set<string>(),
        started: new Set<string>(),
      };
      activeAutoStartRelease = release;
      try {
        // Capture the in-flight run BEFORE awaiting. `run()` returns its
        // promise synchronously, so nothing can settle between these two
        // statements; reading `current()` after the await instead loses a
        // manual run that finished in that window, leaving the synthetic
        // `already_running` result — which reports a cancellation as a failure
        // and loses the real run's `aggregatorId`.
        const attempt = workflowRunner.run(workflow.id, 'startup');
        const inFlight = workflowRunner.current(workflow.id);
        let res = await attempt;
        if (!res.ok && res.error === 'already_running' && inFlight) {
          // A manual run (e.g. the tray ▶▶) was already in flight when boot
          // auto-start fired. Adopt ITS result instead of reporting a spurious
          // failure: the release stays set for the whole wait, so that run's
          // `onBlockComplete` still releases this boot plan's groups.
          res = await inFlight;
        }
        if (!res.ok) {
          reportWithheldGroups(
            withheldGroupIds(plan, release.completed),
            groupsById,
            res.aggregatorId ?? null,
            res.cancelled ? 'cancelled' : 'failure',
          );
        }
      } finally {
        activeAutoStartRelease = null;
      }
    },
  };
}
