import type {
  Group,
  PreScript,
  Workflow,
  WorkflowRunRecord,
  WorkflowTrigger,
} from '../domain-types.js';
import { normalizePreScript, reorderByIds } from '../groups-model.js';
import {
  createWorkflow as newWorkflow,
  makeStartup,
  validateWorkflow,
} from '../workflows.js';
import {
  persistState,
  readGroups,
  readWorkflowRuns,
  readWorkflows,
  writeWorkflowRuns,
} from './store.js';

/**
 * The workflows' persistence: each workflow (a pre-script graph with its own
 * trigger, see src/workflows.ts for the rules), the last run of each, and the
 * per-group script definitions their blocks point at.
 */

export function listWorkflows(): Workflow[] {
  return readWorkflows();
}
export function getWorkflow(id: string): Workflow | null {
  return readWorkflows().find((workflow) => workflow.id === id) ?? null;
}

/**
 * Replaces one workflow (or adds it) in one write. The canvas expresses every
 * edit as the next full graph, so one atomic write — and one broadcast —
 * keeps a gesture from being persisted half-applied. It is validated as a
 * whole first: a cycle, a script placed twice, a second startup workflow…
 * throws with a user-facing reason and leaves the stored one untouched. A ref
 * to a script that no longer exists is not an error — another window may just
 * have deleted it — and is pruned by the persist like on every write.
 */
export function saveWorkflow(data: unknown): Workflow {
  const workflows = readWorkflows();
  const result = validateWorkflow(data, { others: workflows });
  if (!result.ok) throw new Error(result.error);
  const index = workflows.findIndex((w) => w.id === result.workflow.id);
  if (index >= 0) workflows[index] = result.workflow;
  else workflows.push(result.workflow);
  persistState(readGroups(), workflows);
  return getWorkflow(result.workflow.id) ?? result.workflow;
}

export function createWorkflow(
  name: string,
  trigger: WorkflowTrigger,
): Workflow {
  return saveWorkflow(newWorkflow(name, trigger));
}

export function deleteWorkflow(id: string): void {
  persistState(
    readGroups(),
    readWorkflows().filter((workflow) => workflow.id !== id),
  );
  const runs = readWorkflowRuns();
  if (!(id in runs)) return;
  writeWorkflowRuns(
    Object.fromEntries(Object.entries(runs).filter(([key]) => key !== id)),
  );
}

export function setWorkflowEnabled(
  id: string,
  enabled: boolean,
): Workflow | null {
  const workflows = readWorkflows();
  const workflow = workflows.find((candidate) => candidate.id === id);
  if (!workflow) return null;
  workflow.enabled = enabled;
  persistState(readGroups(), workflows);
  return workflow;
}

/** Moves the startup trigger to `id` (the old one becomes manual). */
export function makeStartupWorkflow(id: string): Workflow[] {
  persistState(readGroups(), makeStartup(readWorkflows(), id));
  return readWorkflows();
}

export function getWorkflowRuns(): Record<string, WorkflowRunRecord> {
  return readWorkflowRuns();
}
export function recordWorkflowRun(id: string, run: WorkflowRunRecord): void {
  writeWorkflowRuns({ ...readWorkflowRuns(), [id]: run });
}

/** Only the tray listing changes: a hidden group keeps running as usual. */
export function setGroupHiddenInTray(
  groupId: string,
  hidden: boolean,
): Group | null {
  const groups = readGroups(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  group.hiddenInTray = hidden;
  persistState(groups);
  return group;
}

// Script DEFINITIONS stay per-group (cwd/env come from their own group) but
// are a flat `group.preScripts` list — no block id, since placement into a
// workflow is the graph's concern.
export function savePreScript(
  groupId: string,
  data: unknown,
): PreScript | null {
  const groups = readGroups(),
    groupIndex = groups.findIndex((group) => group.id === groupId),
    group = groups[groupIndex];
  if (!group) return null;
  const normalized = normalizePreScript(data),
    scriptIndex = group.preScripts.findIndex(
      (script) => script.id === normalized.id,
    );
  if (scriptIndex >= 0) group.preScripts[scriptIndex] = normalized;
  else group.preScripts.push(normalized);
  persistState(groups);
  return normalized;
}
export function deletePreScript(groupId: string, scriptId: string): void {
  const groups = readGroups(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  // persistState prunes any now-dangling workflow ref to this script (D5).
  group.preScripts = group.preScripts.filter(
    (script) => script.id !== scriptId,
  );
  persistState(groups);
}
export function reorderPreScripts(
  groupId: string,
  orderedIds: readonly string[],
): void {
  const groups = readGroups(),
    group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return;
  group.preScripts = reorderByIds(group.preScripts, orderedIds);
  persistState(groups);
}
