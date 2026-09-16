import { PIPELINE_LOG_GROUP_ID } from './pipeline-labels.js';

export type ParsedProcessId =
  | { kind: 'command'; groupId: string; commandId: string }
  | { kind: 'action'; groupId: string; actionId: string }
  | { kind: 'prescript'; groupId: string; scriptId: string }
  | { kind: 'preAggregator'; runId: string }
  | { kind: 'unknown' };

export function makeCommandId(groupId: string, commandId: string): string {
  return `cmd:${groupId}:${commandId}`;
}
export function makeActionId(groupId: string, actionId: string): string {
  return `act:${groupId}:${actionId}`;
}
/**
 * `stepId` is deliberately absent: a script's process id (and therefore its
 * log buffer / running state) must stay STABLE while the user drags it
 * between pipeline steps, since steps are now a global ordering concern
 * unrelated to the script's own identity.
 */
export function makePreScriptId(groupId: string, scriptId: string): string {
  return `pre:${groupId}:${scriptId}`;
}
/**
 * `groupId` is deliberately absent: there is exactly one pipeline run (and
 * one aggregator log) at a time, no longer one per group.
 */
export function makeAggregatorId(runId: string | number): string {
  return `pre-pipeline:${runId}`;
}
export function parseProcessId(value: unknown): ParsedProcessId {
  if (typeof value !== 'string') return { kind: 'unknown' };
  let match = /^pre-pipeline:(.+)$/.exec(value);
  if (match?.[1]) return { kind: 'preAggregator', runId: match[1] };
  match = /^pre:([^:]+):(.+)$/.exec(value);
  if (match?.[1] && match[2])
    return { kind: 'prescript', groupId: match[1], scriptId: match[2] };
  match = /^(cmd|act):([^:]+):(.+)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return { kind: 'unknown' };
  return match[1] === 'cmd'
    ? { kind: 'command', groupId: match[2], commandId: match[3] }
    : { kind: 'action', groupId: match[2], actionId: match[3] };
}

/**
 * Does this process belong to the merged log view scoped to `scopeGroupId`?
 *
 * ONE rule for both sides of that view: the snapshot it opens with
 * (`collectMergedSources`) and the lines it receives live (`broadcastLog`).
 * They were written separately once and drifted — the pipeline view listed a
 * script's buffer but never got its new lines, so it only filled in on
 * reload. Keeping the membership in a single pure place is what stops that.
 *
 * - `null` is the "Todo" scope: everything that parses.
 * - The pipeline scope is a cross-group merge of its own narration plus every
 *   pre-script, each tagged with its real group.
 * - A real group takes its own commands, actions and pre-scripts, and never
 *   the pipeline aggregator, which belongs to no single group.
 */
export function belongsToMergedScope(
  parsed: ParsedProcessId,
  scopeGroupId: string | null,
): boolean {
  if (parsed.kind === 'unknown') return false;
  if (scopeGroupId === null) return true;
  if (scopeGroupId === PIPELINE_LOG_GROUP_ID)
    return parsed.kind === 'preAggregator' || parsed.kind === 'prescript';
  if (parsed.kind === 'preAggregator') return false;
  return parsed.groupId === scopeGroupId;
}
