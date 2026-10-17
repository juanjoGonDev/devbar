import type {
  Group,
  LogEntry,
  PreScript,
  PreStepScriptRef,
  Workflow,
  WorkflowRunRecord,
} from './domain-types.js';
import type { WorkflowRunState } from './ipc-contract.js';
import {
  createPreScriptRunner,
  type PreScriptProcessManager,
  type PreScriptRunner,
  type RunResult,
} from './pre-script-runner.js';
import { emptyPipeline } from './pipeline-graph.js';

/**
 * Every workflow's runs. Each workflow gets its own runner
 * (src/pre-script-runner.ts), created the first time it runs, so there is one
 * active run per workflow while different workflows run concurrently. This
 * layer adds what concerns the LIST: finding the workflow, the manual
 * confirmation, run ids unique across workflows, the persisted last run, and
 * the run-state pushes stamped with the workflow they belong to.
 */

/** What started a run: only a manual one asks for confirmation. */
type WorkflowRunCause = 'manual' | 'startup' | 'schedule';

interface WorkflowBlockCompleteEvent {
  workflowId: string;
  blockId: string;
  runId: number;
}

export interface WorkflowRunnerDeps {
  processManager: PreScriptProcessManager;
  configStore: {
    getGroup(groupId: string): Group | null;
    listWorkflows(): Workflow[];
    recordWorkflowRun(workflowId: string, run: WorkflowRunRecord): void;
  };
  /** Something about a run changed: the workflow list must be re-sent. */
  broadcastUpdate: () => void;
  /** The changed run, for `workflows:runState`. */
  onRunState: (state: WorkflowRunState) => void;
  onBlockComplete?: (event: WorkflowBlockCompleteEvent) => void;
  onError?: (
    workflow: Workflow,
    error: string,
    context: { runId?: number; failedScripts?: number },
  ) => void;
  onSuccess?: (
    workflow: Workflow,
    context: { runId: number; scriptCount: number; warned: boolean },
  ) => void;
  /** Asks the user before a manual run of a workflow with `confirm`. */
  confirmWorkflow?: (workflow: Workflow) => Promise<boolean>;
  confirmScript?: (
    script: PreScript,
    group: Group | null,
    groupId: string,
  ) => Promise<boolean>;
  cancelConfirm?: () => void;
}

export interface WorkflowRunner {
  run(workflowId: string, cause?: WorkflowRunCause): Promise<RunResult>;
  stop(workflowId: string): { ok: boolean; error?: string | undefined };
  retryFrom(workflowId: string, blockId: string): Promise<RunResult>;
  /** The latest run of every workflow that still exists. */
  runStates(): WorkflowRunState[];
  runState(workflowId: string): WorkflowRunState | null;
  scriptLog(
    workflowId: string,
    runId: number | 'latest',
    ref: PreStepScriptRef,
  ): LogEntry[] | null;
  isRunning(workflowId: string): boolean;
  anyRunning(): boolean;
  cancelAll(): void;
  /** The in-flight run of `workflowId`, to adopt instead of competing. */
  current(workflowId: string): Promise<RunResult> | null;
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  const runners = new Map<string, PreScriptRunner>();
  // Run ids name the narration log (`pre-pipeline:<runId>`), so two
  // workflows started in the same millisecond must still get two.
  let lastRunId = 0;
  const nextRunId = (): number => {
    lastRunId = Math.max(Date.now(), lastRunId + 1);
    return lastRunId;
  };
  const find = (id: string): Workflow | null =>
    deps.configStore.listWorkflows().find((w) => w.id === id) ?? null;

  function runnerFor(id: string): PreScriptRunner {
    const existing = runners.get(id);
    if (existing) return existing;
    const runner: PreScriptRunner = createPreScriptRunner({
      processManager: deps.processManager,
      configStore: {
        getGroup: (groupId) => deps.configStore.getGroup(groupId),
        getPipeline: () => find(id)?.graph ?? emptyPipeline(),
      },
      workflowId: id,
      name: () => find(id)?.name ?? '',
      nextRunId,
      broadcastUpdate: () => {
        const state = runner.getSnapshot();
        if (state) deps.onRunState(state);
        deps.broadcastUpdate();
      },
      onBlockComplete: ({ blockId, runId }) =>
        deps.onBlockComplete?.({ workflowId: id, blockId, runId }),
      onError: (error, context) => {
        const workflow = find(id);
        if (workflow) deps.onError?.(workflow, error, context);
      },
      onSuccess: (context) => {
        const workflow = find(id);
        if (workflow) deps.onSuccess?.(workflow, context);
      },
      onFinish: (state) => {
        const finishedAt = state.finishedAt ?? Date.now();
        if (state.status === 'running') return;
        deps.configStore.recordWorkflowRun(id, {
          startedAt: state.startedAt,
          finishedAt,
          durationMs: finishedAt - state.startedAt,
          result: state.status,
        });
      },
      confirmScript: deps.confirmScript,
      cancelConfirm: deps.cancelConfirm,
    });
    runners.set(id, runner);
    return runner;
  }

  async function run(
    workflowId: string,
    cause: WorkflowRunCause = 'manual',
  ): Promise<RunResult> {
    const workflow = find(workflowId);
    if (!workflow) return { ok: false, error: 'not_found' };
    const runner = runnerFor(workflowId);
    if (runner.isRunning()) return { ok: false, error: 'already_running' };
    const { trigger } = workflow;
    if (cause === 'manual' && trigger.kind === 'manual' && trigger.confirm) {
      const confirmed = deps.confirmWorkflow
        ? await deps.confirmWorkflow(workflow)
        : false;
      if (!confirmed) return { ok: false, error: 'cancelled', cancelled: true };
    }
    return runner.run();
  }

  const live = (): [string, PreScriptRunner][] => {
    const ids = new Set(deps.configStore.listWorkflows().map((w) => w.id));
    return [...runners].filter(([id]) => ids.has(id));
  };

  return {
    run,
    stop: (id) =>
      runners.get(id)?.cancel() ?? { ok: false, error: 'not_running' },
    retryFrom: (id, blockId) =>
      find(id)
        ? runnerFor(id).retryFrom(blockId)
        : Promise.resolve({ ok: false, error: 'not_found' }),
    runStates: () =>
      live().flatMap(([, runner]) => {
        const state = runner.getSnapshot();
        return state ? [state] : [];
      }),
    runState: (id) => runners.get(id)?.getSnapshot() ?? null,
    scriptLog: (id, runId, ref) =>
      runners.get(id)?.scriptLog(runId, ref) ?? null,
    isRunning: (id) => runners.get(id)?.isRunning() ?? false,
    anyRunning: () => [...runners.values()].some((r) => r.isRunning()),
    cancelAll: () => {
      for (const runner of runners.values())
        if (runner.isRunning()) runner.cancel();
    },
    current: (id) => runners.get(id)?.current() ?? null,
  };
}
