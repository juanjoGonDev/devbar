import type { Pipeline, Workflow } from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

/**
 * The pipeline editor edits the startup workflow's graph: these build what
 * main answers for it (`listWorkflows`, `saveWorkflow`) around one graph.
 */

export function startupWorkflow(graph: Pipeline, enabled = false): Workflow {
  return {
    id: 'w-start',
    name: 'Arranque',
    enabled,
    showInTray: true,
    showInRemote: true,
    trigger: { kind: 'startup' },
    graph,
  };
}

export function startupEntries(
  graph: Pipeline,
  enabled = false,
): WorkflowEntry[] {
  return [
    {
      workflow: startupWorkflow(graph, enabled),
      lastRun: null,
      nextRunAt: null,
      scriptCount: 0,
      running: null,
    },
  ];
}
