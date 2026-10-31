import { parseProcessId } from '../compound-id.js';
import {
  buildFixtureGroups,
  clampFixtureRepeat,
  FIXTURE_ID_PREFIX,
  type FixtureEnvironment,
} from './fixture-groups.js';
import {
  buildFixtureWorkflowRuns,
  buildFixtureWorkflows,
} from './fixture-workflows.js';
import type { Group, Workflow, WorkflowRunRecord } from '../domain-types.js';

/**
 * Turns the dev panel's "Grupos y workflows de prueba" on and off.
 *
 * On: the store's overlay takes the fixture groups, the fixture workflows and
 * their seeded last runs, so every window shows only the test set while the
 * user's own groups, workflows and run history stay on disk untouched — and
 * their running processes keep running, out of sight. Nothing is run: the
 * startup workflow only runs at boot, and the overlay never survives one.
 *
 * Off: every workflow run still going is cancelled and AWAITED (so its last
 * run lands in the overlay, not in the real history), then every fixture
 * process is stopped and awaited, then the overlay goes and the real groups
 * and workflows come back. A stop that fails keeps the overlay up: dropping
 * it would leave a running child that no window can reach.
 *
 * Nothing is persisted, so a restart while it is on comes back on the real
 * configuration too.
 */

export interface FixtureOverlay {
  groups: readonly Group[];
  workflows: readonly Workflow[];
  workflowRuns: Readonly<Record<string, WorkflowRunRecord>>;
}

export interface FixtureHost {
  environment: () => FixtureEnvironment;
  setOverlay: (overlay: FixtureOverlay | null) => void;
  /** The listed workflows (the overlay's, while it is on) running now. */
  runningWorkflowIds: () => string[];
  /** Cancels a workflow run and resolves once it has settled. */
  stopWorkflow: (id: string) => Promise<void>;
  /** Every process id the process manager tracks. */
  processIds: () => string[];
  stop: (id: string) => Promise<{ ok: boolean; error?: string | undefined }>;
  removeState: (id: string) => void;
  /** Repaints every window and re-targets the repo watchers. */
  refresh: () => void;
}

export interface FixtureStatus {
  active: boolean;
  repeat: number;
}

export interface FixtureResult extends FixtureStatus {
  ok: boolean;
  error?: string;
}

/** Whether a process belongs to a fixture group (never a real one). */
export function isFixtureProcess(id: string): boolean {
  const parsed = parseProcessId(id);
  return (
    (parsed.kind === 'command' ||
      parsed.kind === 'action' ||
      parsed.kind === 'prescript') &&
    parsed.groupId.startsWith(FIXTURE_ID_PREFIX)
  );
}

export function createFixtureMode(host: FixtureHost): {
  status: () => FixtureStatus;
  enable: (repeat: unknown) => Promise<FixtureResult>;
  disable: () => Promise<FixtureResult>;
} {
  let active = false;
  let repeat = 1;
  const status = (): FixtureStatus => ({ active, repeat });

  /** Stops the demo runs, then every fixture process; what would not stop. */
  async function stopFixtures(): Promise<string[]> {
    await Promise.all(
      host.runningWorkflowIds().map((id) => host.stopWorkflow(id)),
    );
    const ids = host.processIds().filter(isFixtureProcess);
    const results = await Promise.all(ids.map((id) => host.stop(id)));
    const failed = ids.filter((_, index) => !results[index]?.ok);
    for (const id of ids) if (!failed.includes(id)) host.removeState(id);
    return failed;
  }

  function refused(failed: string[]): FixtureResult {
    return {
      ok: false,
      ...status(),
      error: `No se pudieron parar: ${failed.join(', ')}`,
    };
  }

  return {
    status,
    async enable(requested) {
      const copies = clampFixtureRepeat(requested);
      if (active) {
        const failed = await stopFixtures();
        if (failed.length) return refused(failed);
      }
      host.setOverlay({
        groups: buildFixtureGroups(host.environment(), copies),
        workflows: buildFixtureWorkflows(),
        workflowRuns: buildFixtureWorkflowRuns(Date.now()),
      });
      active = true;
      repeat = copies;
      host.refresh();
      return { ok: true, ...status() };
    },
    async disable() {
      if (!active) return { ok: true, ...status() };
      const failed = await stopFixtures();
      if (failed.length) return refused(failed);
      host.setOverlay(null);
      active = false;
      host.refresh();
      return { ok: true, ...status() };
    },
  };
}
