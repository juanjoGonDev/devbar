export type ParsedProcessId =
  | { kind: 'command'; groupId: string; commandId: string }
  | { kind: 'action'; groupId: string; actionId: string }
  | { kind: 'prescript'; groupId: string; stepId: string; scriptId: string }
  | { kind: 'preAggregator'; groupId: string; runId: string }
  | { kind: 'unknown' };

export function makeCommandId(groupId: string, commandId: string): string {
  return `cmd:${groupId}:${commandId}`;
}
export function makeActionId(groupId: string, actionId: string): string {
  return `act:${groupId}:${actionId}`;
}
export function makePreScriptId(
  groupId: string,
  stepId: string,
  scriptId: string,
): string {
  return `pre:${groupId}:${stepId}:${scriptId}`;
}
export function makeAggregatorId(
  groupId: string,
  runId: string | number,
): string {
  return `pre-pipeline:${groupId}:${runId}`;
}
export function parseProcessId(value: unknown): ParsedProcessId {
  if (typeof value !== 'string') return { kind: 'unknown' };
  let match = /^pre:([^:]+):([^:]+):(.+)$/.exec(value);
  if (match?.[1] && match[2] && match[3])
    return {
      kind: 'prescript',
      groupId: match[1],
      stepId: match[2],
      scriptId: match[3],
    };
  match = /^pre-pipeline:([^:]+):(.+)$/.exec(value);
  if (match?.[1] && match[2])
    return { kind: 'preAggregator', groupId: match[1], runId: match[2] };
  match = /^(cmd|act):([^:]+):(.+)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return { kind: 'unknown' };
  return match[1] === 'cmd'
    ? { kind: 'command', groupId: match[2], commandId: match[3] }
    : { kind: 'action', groupId: match[2], actionId: match[3] };
}
