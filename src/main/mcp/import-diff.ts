import type { ImportPayload } from '../../config-io.js';
import type { Group, Workflow } from '../../domain-types.js';
import type { McpDiffLine } from '../../ipc-contract/mcp-api.js';
import {
  ACTION_FIELDS,
  COMMAND_FIELDS,
  diffEntity,
  GROUP_FIELDS,
  PRESCRIPT_FIELDS,
  visible,
  workflowFields,
  type EntityDiff,
  type Field,
} from './config-diff.js';

/**
 * The confirmation of an `import_config`: every group, command, action,
 * pre-script and workflow the import adds, changes or removes, field by
 * field, so a backup that keeps the group names but swaps every command line
 * still shows what it would run. Entities it leaves as they are stay out.
 */

const changes = (lines: readonly McpDiffLine[]): boolean =>
  lines.some((line) => line.kind !== 'ctx');

/** Each entity's diff by id: changed, added, then removed ones. */
function byId<T extends { id: string }>(
  fields: readonly Field<T>[],
  before: readonly T[],
  after: readonly T[],
): McpDiffLine[] {
  const lines: McpDiffLine[] = [];
  for (const next of after) {
    const old = before.find((entity) => entity.id === next.id) ?? null;
    const { diff } = diffEntity(fields, old, next);
    if (changes(diff)) lines.push(...diff);
  }
  for (const old of before)
    if (!after.some((entity) => entity.id === old.id))
      lines.push(...diffEntity(fields, old, null).diff);
  return lines;
}

function groupLines(old: Group | null, next: Group): McpDiffLine[] {
  // The header names the group; its own «nombre» line only for a rename.
  const own = diffEntity(GROUP_FIELDS, old, next).diff.filter(
    (line) => line.field !== 'nombre' || (old !== null && line.kind !== 'ctx'),
  );
  const lines = [
    ...own,
    ...byId(COMMAND_FIELDS, old?.commands ?? [], next.commands),
    ...byId(ACTION_FIELDS, old?.actions ?? [], next.actions),
    ...byId(PRESCRIPT_FIELDS, old?.preScripts ?? [], next.preScripts),
  ];
  if (!changes(lines)) return [];
  const header: McpDiffLine = {
    kind: old ? 'ctx' : 'add',
    field: 'grupo',
    text: visible(next.name),
  };
  return [header, ...lines];
}

export function importDiff(
  current: readonly Group[],
  currentWorkflows: readonly Workflow[],
  incoming: ImportPayload,
): EntityDiff {
  const diff: McpDiffLine[] = [];
  for (const next of incoming.groups)
    diff.push(
      ...groupLines(current.find((g) => g.id === next.id) ?? null, next),
    );
  for (const old of current)
    if (!incoming.groups.some((g) => g.id === old.id))
      diff.push({ kind: 'del', field: 'grupo', text: visible(old.name) });
  const groups = [...incoming.groups, ...current];
  const scriptName = (groupId: string, scriptId: string): string => {
    const group = groups.find((g) => g.id === groupId);
    const script = group?.preScripts.find((s) => s.id === scriptId);
    return `${group?.name ?? groupId} › ${script?.name ?? scriptId}`;
  };
  diff.push(
    ...byId(workflowFields(scriptName), currentWorkflows, incoming.workflows),
  );
  return { diff, changed: ['configuración completa'], risk: 'destructive' };
}
