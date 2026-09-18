import type { PreScript, PreStep, PreStepScriptRef } from '../domain-types.js';
import {
  normalizePreScript,
  normalizePreStep,
  reorderByIds,
  assignScriptToStep as assignRefToStep,
  unassignScriptFromStep as unassignRefFromStep,
} from '../groups-model.js';
import { persistState, readGroups, readPreSteps } from './store.js';

/**
 * The pre-script pipeline's persistence: the GLOBAL ordered steps, the
 * per-group script definitions they point at, and the placement of one into
 * the other.
 */

// Pipeline steps are a GLOBAL, top-level slice — no `groupId`, since a step
// can hold refs into more than one group's scripts.
export function getPreSteps(): PreStep[] {
  return readPreSteps();
}
export function savePreStep(data: unknown): PreStep {
  const steps = readPreSteps();
  const normalized = normalizePreStep(data);
  const index = steps.findIndex((step) => step.id === normalized.id);
  if (index >= 0) steps[index] = normalized;
  else steps.push(normalized);
  persistState(readGroups(), steps);
  return normalized;
}
export function deletePreStep(stepId: string): void {
  const steps = readPreSteps().filter((step) => step.id !== stepId);
  persistState(readGroups(), steps);
}
export function reorderPreSteps(orderedIds: readonly string[]): PreStep[] {
  const sorted = reorderByIds(readPreSteps(), orderedIds);
  persistState(readGroups(), sorted);
  return sorted;
}

// Script DEFINITIONS stay per-group (cwd/env come from their own group) but
// are a flat `group.preScripts` list — no `stepId`, since placement into the
// pipeline is a separate concern (assignScriptToStep/unassignScriptFromStep
// below).
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
  // persistState prunes any now-dangling pipeline ref to this script (D5).
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

// Placement of an already-defined script into (or out of) a global step.
export function assignScriptToStep(
  stepId: string,
  groupId: string,
  scriptId: string,
  position?: number,
): PreStep[] {
  const ref: PreStepScriptRef = { groupId, scriptId };
  const steps = assignRefToStep(readPreSteps(), stepId, ref, position);
  persistState(readGroups(), steps);
  return steps;
}
export function unassignScriptFromStep(
  stepId: string,
  groupId: string,
  scriptId: string,
): PreStep[] {
  const ref: PreStepScriptRef = { groupId, scriptId };
  const steps = unassignRefFromStep(readPreSteps(), stepId, ref);
  persistState(readGroups(), steps);
  return steps;
}
