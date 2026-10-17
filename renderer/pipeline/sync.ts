import { latestWins } from '../latest-wins.js';
import { reasonOf } from '../workflows/trigger-meta.js';
import { emptyPipeline } from '../../src/pipeline-graph.js';
import type { Pipeline, Workflow } from '../../src/domain-types.js';

/** What the editor may change about a workflow besides its graph. */
type WorkflowMeta = Partial<
  Pick<Workflow, 'name' | 'trigger' | 'showInTray' | 'showInRemote'>
>;

export interface PipelineSync {
  /** The pipeline the canvas shows: the stored one plus local edits. */
  get(): Pipeline;
  /** Whether the stored pipeline has been read at least once. */
  loaded(): boolean;
  /** The workflow whose graph this is, once read (null: none yet). */
  workflow(): Workflow | null;
  /**
   * Which workflow to edit from now on (null: the startup one). Takes effect
   * on the next `refresh`.
   */
  target(workflowId: string | null): void;
  /**
   * Shows `next` at once and writes it — a dragged block's position only
   * after a pause, so one drag is one write. A no-op edit (the very same
   * object back from the model) writes nothing.
   */
  apply(next: Pipeline, options?: { debounce?: boolean }): void;
  /** Renames the workflow or changes its trigger, queued with the graph. */
  setMeta(meta: WorkflowMeta): Promise<void>;
  /**
   * Adopts what main now stores for the workflow's name, trigger and
   * `enabled` (a push, or another call's answer) — unless a write of ours
   * is still on its way, whose own answer then decides.
   */
  adopt(workflow: Workflow): void;
  /** Writes any pending edit, then re-reads what main stores. */
  refresh(): Promise<void>;
}

export interface PipelineSyncDeps {
  /** The pipeline changed: repaint. */
  onChange(): void;
  showToast(message: string, kind?: string): void;
  debounceMs: number;
}

interface WriteJob {
  base: Workflow | null;
  target: string | null;
  graph: Pipeline;
  at: number;
}

/**
 * The editor's link to one stored workflow. Edits are local first and
 * written with `saveWorkflow`, one at a time in order; main's normalized
 * answer is adopted unless a newer edit already owns the screen. A rejected
 * write is reported with main's reason and the stored workflow re-read, so
 * the screen never shows a change that was not persisted.
 */
export function createPipelineSync(deps: PipelineSyncDeps): PipelineSync {
  let pipeline: Pipeline = emptyPipeline();
  let workflow: Workflow | null = null;
  let targetId: string | null = null;
  let loaded = false;
  /** Bumped by every local change, so an older write's echo never lands. */
  let revision = 0;
  /** Writes queued or in flight. */
  let pending = 0;
  let writes: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Ticket for the in-flight read. Nothing serializes reads, and the older
   * answer landing last would drop whatever a newer edit just persisted.
   */
  const reads = latestWins();

  async function reload(): Promise<void> {
    // Issuing this read retires every older one still in flight.
    reads.invalidate();
    const current = reads.claim();
    const entries = await window.api.listWorkflows();
    if (!current()) return; // a newer read already answered
    workflow =
      entries.find((entry) =>
        targetId === null
          ? entry.workflow.trigger.kind === 'startup'
          : entry.workflow.id === targetId,
      )?.workflow ?? null;
    pipeline = workflow?.graph ?? emptyPipeline();
    revision++;
    loaded = true;
  }

  async function write(job: WriteJob): Promise<void> {
    try {
      // The first edit of a store with no startup workflow creates «Arranque».
      const owner =
        job.base ??
        (job.target === null
          ? await window.api.createWorkflow('Arranque', { kind: 'startup' })
          : null);
      if (!owner) return;
      const saved = await window.api.saveWorkflow({
        ...owner,
        graph: job.graph,
      });
      if (job.target !== targetId) return; // the editor moved on meanwhile
      if (job.at === revision && Array.isArray(saved.graph.blocks)) {
        workflow = saved;
        pipeline = saved.graph;
        deps.onChange();
      } else if (workflow === null) workflow = saved;
    } catch (error) {
      deps.showToast(
        reasonOf(error) || 'No se pudo guardar el workflow',
        'error',
      );
      // The re-read is best-effort: if it fails too, the edit must still
      // settle, or every caller produces an unhandled rejection.
      try {
        await reload();
        deps.onChange();
      } catch {
        deps.showToast('No se pudo recargar el workflow', 'error');
      }
    }
  }

  function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Everything the write needs is taken NOW: by the time it runs the
    // editor may already show another workflow.
    const job: WriteJob = {
      base: workflow,
      target: targetId,
      graph: pipeline,
      at: revision,
    };
    pending++;
    writes = writes
      .then(() => write(job))
      .finally(() => {
        pending--;
      });
    return writes;
  }

  function apply(next: Pipeline, options: { debounce?: boolean } = {}): void {
    if (next === pipeline) return; // the model said this edit is a no-op
    pipeline = next;
    revision++;
    deps.onChange();
    if (timer !== null) clearTimeout(timer);
    if (options.debounce)
      timer = setTimeout(() => void flush(), deps.debounceMs);
    else void flush();
  }

  function setMeta(meta: WorkflowMeta): Promise<void> {
    if (!workflow) return Promise.resolve();
    workflow = { ...workflow, ...meta };
    revision++;
    deps.onChange();
    return flush();
  }

  function adopt(next: Workflow): void {
    if (!workflow || next.id !== workflow.id || pending > 0) return;
    const { name, trigger, enabled, showInTray, showInRemote } = next;
    workflow = {
      ...workflow,
      name,
      trigger,
      enabled,
      showInTray,
      showInRemote,
    };
  }

  async function refresh(): Promise<void> {
    if (timer !== null) await flush();
    await reload();
  }

  return {
    get: () => pipeline,
    loaded: () => loaded,
    workflow: () => workflow,
    target: (id) => {
      if (id === targetId) return;
      if (timer !== null) void flush(); // a pending drag belongs to the old one
      targetId = id;
      workflow = null;
      pipeline = emptyPipeline();
      loaded = false;
      revision++;
    },
    apply,
    setMeta,
    adopt,
    refresh,
  };
}
