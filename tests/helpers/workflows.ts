/// <reference lib="dom" />
/**
 * Fixtures for the settings' Workflows section: entries shaped like what
 * main answers on `listWorkflows`, and run states like `workflows:runState`.
 */
import type {
  Pipeline,
  Workflow,
  WorkflowTrigger,
} from '../../src/domain-types.js';
import type {
  WorkflowEntry,
  WorkflowRunState,
} from '../../src/ipc-contract.js';

export const MANUAL: WorkflowTrigger = { kind: 'manual', confirm: false };
export const STARTUP: WorkflowTrigger = { kind: 'startup' };
export const NIGHTLY: WorkflowTrigger = {
  kind: 'schedule',
  schedule: {
    rules: [{ time: '23:30', days: [1, 2, 3, 4, 5] }],
    interval: null,
  },
};

export function workflow(
  id: string,
  trigger: WorkflowTrigger,
  extra: Partial<Workflow> = {},
): Workflow {
  return {
    id,
    name: id,
    enabled: true,
    hidden: false,
    trigger,
    graph: { blocks: [], edges: [] },
    ...extra,
  };
}

export function wfEntry(
  id: string,
  trigger: WorkflowTrigger,
  extra: Partial<WorkflowEntry> = {},
  wf: Partial<Workflow> = {},
): WorkflowEntry {
  return {
    workflow: workflow(id, trigger, wf),
    lastRun: null,
    nextRunAt: null,
    scriptCount: 1,
    running: null,
    ...extra,
  };
}

export function entryOf(
  wf: Workflow,
  extra: Partial<WorkflowEntry> = {},
): WorkflowEntry {
  return {
    workflow: wf,
    lastRun: null,
    nextRunAt: null,
    scriptCount: 1,
    running: null,
    ...extra,
  };
}

/** A run of `workflowId` with one block state per entry of `blocks`. */
export function runState(
  workflowId: string,
  pipeline: Pipeline,
  status: WorkflowRunState['status'],
  blocks: Record<string, WorkflowRunState['blocks'][number]['status']>,
  extra: Partial<WorkflowRunState> = {},
): WorkflowRunState {
  const startedAt = 1_000;
  return {
    workflowId,
    runId: 7,
    aggregatorId: `agg-${workflowId}`,
    status,
    blocks: Object.entries(blocks).map(([blockId, s]) => ({
      blockId,
      status: s,
      startedAt: s === 'waiting' ? null : startedAt,
      finishedAt: ['running', 'waiting'].includes(s) ? null : startedAt + 2_000,
    })),
    scripts: pipeline.blocks.flatMap((block) =>
      block.scripts.map((ref) => {
        const s = blocks[block.id] ?? 'waiting';
        return {
          ...ref,
          blockId: block.id,
          status: s,
          startedAt: s === 'waiting' ? null : startedAt,
          finishedAt: ['running', 'waiting'].includes(s)
            ? null
            : startedAt + 3_200,
          exitCode: s === 'error' ? 1 : s === 'success' ? 0 : null,
        };
      }),
    ),
    doneScripts: 0,
    totalScripts: pipeline.blocks.flatMap((b) => b.scripts).length,
    startedAt,
    finishedAt: status === 'running' ? null : startedAt + 4_000,
    ...extra,
  };
}

export function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.wf-row[data-id]')];
}

export function rowFor(id: string): HTMLElement {
  const found = rows().find((row) => row.dataset.id === id);
  if (!found) throw new Error(`the list draws no row for ${id}`);
  return found;
}

export function cellText(row: HTMLElement, selector: string): string {
  return (row.querySelector(selector)?.textContent ?? '')
    .replace(/[-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
