import { latestWins } from '../latest-wins.js';
import {
  initPipelineEditor,
  type PipelineEditorDeps,
  type PipelineEditorHandle,
} from '../pipeline-editor.js';
import { runningCount } from './list-model.js';
import { createWorkflowList } from './list-view.js';
import type { Group } from '../../src/domain-types.js';
import type {
  WorkflowEntry,
  WorkflowRunState,
} from '../../src/ipc-contract.js';

export interface WorkflowsSectionDeps {
  listHost: HTMLElement;
  editorHost: HTMLElement;
  /** The count on the nav item: workflows running right now. */
  badge: HTMLElement;
  getGroups: () => readonly Group[];
  showToast: (message: string, kind?: string) => void;
  editScript?: PipelineEditorDeps['editScript'];
  createScript?: PipelineEditorDeps['createScript'];
  moveDebounceMs?: number;
  now?: () => number;
}

export interface WorkflowsSection {
  /** Reads the list and the runs of this session, then keeps them live. */
  load(): Promise<void>;
  /** Back to the list (the tray's «Ver todos» lands here). */
  showList(): void;
  open(workflowId: string, options?: { rename?: boolean }): Promise<void>;
  /** Groups or scripts changed elsewhere: re-read the open workflow. */
  refresh(): Promise<void>;
  editor: PipelineEditorHandle;
}

/**
 * The settings' Workflows section: the list of every workflow and, one click
 * away, the editor of one. It owns the live state both read — the list
 * (`workflows:update`) and each workflow's latest run (`workflows:runState`)
 * — and the nav badge counting what is running.
 */
export function createWorkflowsSection(
  deps: WorkflowsSectionDeps,
): WorkflowsSection {
  let entries: readonly WorkflowEntry[] = [];
  const runs = new Map<string, WorkflowRunState>();
  let editing: string | null = null;
  const reads = latestWins();

  const editor = initPipelineEditor(deps.editorHost, {
    getGroups: deps.getGroups,
    showToast: deps.showToast,
    ...(deps.editScript ? { editScript: deps.editScript } : {}),
    ...(deps.createScript ? { createScript: deps.createScript } : {}),
    ...(deps.moveDebounceMs !== undefined
      ? { moveDebounceMs: deps.moveDebounceMs }
      : {}),
    ...(deps.now ? { now: deps.now } : {}),
    getEntries: () => entries,
    onBack: () => showList(),
  });
  const list = createWorkflowList({
    host: deps.listHost,
    getGroups: deps.getGroups,
    ...(deps.now ? { now: deps.now } : {}),
    open: (id, options) => void open(id, options),
    showToast: deps.showToast,
  });

  function paintBadge(): void {
    const running = new Set(
      entries.filter((e) => e.running).map((e) => e.workflow.id),
    );
    for (const run of runs.values())
      if (run.status === 'running') running.add(run.workflowId);
    const count = Math.max(runningCount(entries), running.size);
    deps.badge.textContent = String(count);
    deps.badge.hidden = count === 0;
  }

  function showList(): void {
    editing = null;
    deps.editorHost.hidden = true;
    deps.listHost.hidden = false;
    list.render(entries);
  }

  async function open(
    workflowId: string,
    options: { rename?: boolean } = {},
  ): Promise<void> {
    editing = workflowId;
    deps.listHost.hidden = true;
    deps.editorHost.hidden = false;
    editor.setRun(null);
    const pending = editor.open(workflowId, options);
    editor.setRun(runs.get(workflowId) ?? null);
    await pending;
  }

  function adopt(next: readonly WorkflowEntry[]): void {
    entries = next;
    paintBadge();
    list.render(entries);
    if (editing === null) return;
    if (!entries.some((e) => e.workflow.id === editing)) showList();
    else editor.entriesChanged();
  }

  window.api.onWorkflowsUpdate((next) => {
    // A push is newer than any read still on its way.
    reads.invalidate();
    adopt(next);
  });
  window.api.onWorkflowRunState((state) => {
    runs.set(state.workflowId, state);
    paintBadge();
    if (state.workflowId === editing) editor.setRun(state);
  });

  showList();

  return {
    load: async () => {
      reads.invalidate();
      const current = reads.claim();
      const [read, states] = await Promise.all([
        window.api.listWorkflows(),
        window.api.getWorkflowRunStates().catch(() => []),
      ]);
      for (const state of states)
        if (!runs.has(state.workflowId)) runs.set(state.workflowId, state);
      if (current()) adopt(read);
      else paintBadge();
    },
    showList,
    open,
    refresh: async () => {
      if (editing !== null) await editor.refresh();
    },
    editor,
  };
}
