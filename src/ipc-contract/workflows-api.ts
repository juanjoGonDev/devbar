import type {
  Group,
  LogEntry,
  PreStepScriptRef,
  Workflow,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkflowTrigger,
} from '../domain-types.js';
import type { SimpleResult } from './simple-result.js';

/**
 * Where one block or one script of a workflow run stands. `warning` is a
 * clean exit whose output matched the owning group's warn pattern (or, for a
 * block, one that finished with such a script or with a failure it tolerated
 * because «Todos OK» was off). `idle` is a block the run never reaches (it is
 * not connected to the trigger).
 */
export type WorkflowNodeStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'success'
  | 'warning'
  | 'error'
  | 'skipped'
  | 'cancelled';

export interface WorkflowBlockRunState {
  blockId: string;
  status: WorkflowNodeStatus;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowScriptRunState extends PreStepScriptRef {
  blockId: string;
  status: WorkflowNodeStatus;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
}

/**
 * One workflow's latest run — in flight or finished — as pushed on
 * `workflows:runState` after every change. A retry (`retryWorkflowFrom`) is
 * a new run (new `runId`) that carries the untouched blocks over.
 */
export interface WorkflowRunState {
  workflowId: string;
  runId: number;
  /** The run's own narration log: open it with `openLogs(aggregatorId)`. */
  aggregatorId: string;
  /** `running`, then how it ended. */
  status: 'running' | WorkflowRunResult;
  blocks: WorkflowBlockRunState[];
  scripts: WorkflowScriptRunState[];
  /** Scripts settled so far (finished, failed, cancelled or skipped). */
  doneScripts: number;
  /** Scripts in blocks connected to the trigger. */
  totalScripts: number;
  startedAt: number;
  finishedAt: number | null;
}

/** One row of the workflow list, pushed on `workflows:update`. */
export interface WorkflowEntry {
  workflow: Workflow;
  /** The last FINISHED run, persisted across restarts. */
  lastRun: WorkflowRunRecord | null;
  /** When a scheduled (and enabled) workflow fires next, epoch ms. */
  nextRunAt: number | null;
  /** Scripts in blocks connected to the trigger: 0 means nothing to run. */
  scriptCount: number;
  /** The run in flight, if any (its full detail is on `workflows:runState`). */
  running: {
    runId: number;
    doneScripts: number;
    totalScripts: number;
    startedAt: number;
  } | null;
}

/** How `runWorkflow` / `retryWorkflowFrom` end. */
interface WorkflowRunOutcome {
  ok: boolean;
  runId?: number | undefined;
  /** `already_running`, `cancelled`, `scripts_failed:<n>`, `not_found`… */
  error?: string | undefined;
  cancelled?: boolean | undefined;
}

/** The workflow calls of the window API (part of `DevBarApi`). */
export interface WorkflowsApi {
  listWorkflows(): Promise<WorkflowEntry[]>;
  /**
   * Replaces (or adds) one workflow in one atomic write and resolves to what
   * was stored (refs to missing scripts pruned). Rejects, with a Spanish
   * reason fit for a toast, what main refuses: a blank name, an unknown
   * trigger, a second startup workflow, a graph with a cycle, a script placed
   * twice, a dangling/repeated/self edge…
   */
  saveWorkflow(workflow: Workflow): Promise<Workflow>;
  /** Enabled, empty graph. Rejects a second startup workflow. */
  createWorkflow(name: string, trigger: WorkflowTrigger): Promise<Workflow>;
  /** Stops it first when it is running. */
  deleteWorkflow(workflowId: string): Promise<SimpleResult>;
  setWorkflowEnabled(
    workflowId: string,
    enabled: boolean,
  ): Promise<Workflow | null>;
  /** Moves the startup trigger here; the previous one becomes manual. */
  makeStartupWorkflow(workflowId: string): Promise<Workflow[]>;
  /** Resolves when the run ends. Asks first for a manual one with `confirm`. */
  runWorkflow(workflowId: string): Promise<WorkflowRunOutcome>;
  stopWorkflow(workflowId: string): Promise<SimpleResult>;
  /**
   * Re-runs `blockId` and its descendants that did not succeed, keeping the
   * successful blocks. Only once the run has finished (`already_running`),
   * and only for a block whose sources all succeeded (`not_ready`).
   */
  retryWorkflowFrom(
    workflowId: string,
    blockId: string,
  ): Promise<WorkflowRunOutcome>;
  /** The latest run of every workflow that ran this session. */
  getWorkflowRunStates(): Promise<WorkflowRunState[]>;
  /** One script's output during one run (`'latest'`: the latest run). */
  getWorkflowScriptLog(
    workflowId: string,
    runId: number | 'latest',
    ref: PreStepScriptRef,
  ): Promise<LogEntry[] | null>;
  /** The logs window, on the script (or, with no ref, the run's narration). */
  openWorkflowLog(
    workflowId: string,
    ref?: PreStepScriptRef | null,
  ): Promise<SimpleResult>;
  onWorkflowsUpdate(callback: (entries: WorkflowEntry[]) => void): () => void;
  onWorkflowRunState(callback: (state: WorkflowRunState) => void): () => void;
  /** Folds the group into the tray's «N oculto(s)»; it keeps running. */
  setGroupHiddenInTray(groupId: string, hidden: boolean): Promise<Group | null>;
}
