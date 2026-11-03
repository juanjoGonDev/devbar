import { z } from 'zod';
import type { Group, Workflow } from '../../../domain-types.js';
import { PIPELINE_TRIGGER } from '../../../pipeline-graph.js';
import { validateWorkflow } from '../../../workflows.js';
import { diffEntity, workflowFields, type EntityDiff } from '../config-diff.js';
import { applyChange, given, handlerError } from './config-apply.js';
import {
  reason,
  WORKFLOW_INPUT,
  type GraphInput,
  type TriggerInput,
} from './config-schemas.js';
import {
  defineTool,
  findGroup,
  findPreScript,
  findWorkflow,
  ToolError,
  workflowAllowed,
  type ToolContext,
  type ToolDef,
} from './tool-kit.js';

/**
 * The `config` scope for workflows and the configuration as a whole:
 * create, update and delete workflows (trigger, graph, «Todos OK»), export,
 * import (replace everything) and undo the client's latest change.
 */

const DESTRUCTIVE = { destructiveHint: true, openWorldHint: false } as const;
const WRITES = { destructiveHint: false, openWorldHint: false } as const;

/** Canvas spacing for blocks placed without coordinates. */
const COLUMN = 240;
const ROW = 120;

function scriptNamer(
  ctx: ToolContext,
): (groupId: string, scriptId: string) => string {
  const groups = ctx.runtime.listGroups();
  return (groupId, scriptId) => {
    const group = groups.find((g) => g.id === groupId);
    const script = group?.preScripts.find((s) => s.id === scriptId);
    return `${group?.name ?? groupId} › ${script?.name ?? scriptId}`;
  };
}

/** Names → ids, and a position for every block that has none. */
function graphFrom(ctx: ToolContext, graph: GraphInput): Workflow['graph'] {
  return {
    blocks: graph.blocks.map((block, index) => ({
      id: block.id,
      scripts: block.scripts.map((ref) => {
        const group = findGroup(ctx, ref.group);
        return {
          groupId: group.id,
          scriptId: findPreScript(group, ref.script).id,
        };
      }),
      requireAll: block.requireAll ?? true,
      x: block.x ?? COLUMN * (index + 1),
      y: block.y ?? ROW,
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from === 'trigger' ? PIPELINE_TRIGGER : edge.from,
      to: edge.to,
    })),
  };
}

function triggerFrom(trigger: TriggerInput): Workflow['trigger'] {
  if (trigger.kind === 'startup') return { kind: 'startup' };
  if (trigger.kind === 'manual')
    return { kind: 'manual', confirm: trigger.confirm ?? false };
  return {
    kind: 'schedule',
    schedule: {
      rules: trigger.schedule.rules ?? [],
      interval: trigger.schedule.interval
        ? {
            ...trigger.schedule.interval,
            window: trigger.schedule.interval.window ?? null,
            days: trigger.schedule.interval.days ?? [],
          }
        : null,
    },
  };
}

function validated(ctx: ToolContext, raw: unknown): Workflow {
  const result = validateWorkflow(raw, {
    others: ctx.runtime.workflowEntries().map((entry) => entry.workflow),
  });
  if (!result.ok) throw new ToolError(result.error);
  return result.workflow;
}

function workflowRaw(
  ctx: ToolContext,
  args: Record<string, unknown>,
  before: Workflow | null,
): Record<string, unknown> {
  const fields = given(args, ['workflow', 'reason', 'trigger', 'graph']);
  return {
    ...(before ?? {
      trigger: { kind: 'manual', confirm: false },
      graph: { blocks: [], edges: [] },
    }),
    ...fields,
    ...(args.trigger
      ? { trigger: triggerFrom(args.trigger as TriggerInput) }
      : {}),
    ...(args.graph ? { graph: graphFrom(ctx, args.graph as GraphInput) } : {}),
  };
}

function saveWorkflow(ctx: ToolContext, workflow: Workflow) {
  return async (): Promise<string | null> => {
    try {
      return handlerError(
        await ctx.changes.port.invoke('workflows:save', { workflow }),
        'No se pudo guardar el workflow',
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}

/** What a whole-config import would replace, in diff lines. */
function importDiff(current: Group[], incoming: unknown): EntityDiff {
  const groups = (incoming as { groups?: unknown }).groups;
  const names = Array.isArray(groups)
    ? groups.map((g) => String((g as { name?: unknown }).name ?? '?'))
    : [];
  return {
    diff: [
      ...current.map((g) => ({
        kind: 'del' as const,
        field: 'grupo',
        text: g.name,
      })),
      ...names.map((name) => ({
        kind: 'add' as const,
        field: 'grupo',
        text: name,
      })),
    ],
    changed: ['configuración completa'],
    risk: 'destructive',
  };
}

export const WORKFLOW_CONFIG_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: 'create_workflow',
    scope: 'config',
    title: 'Create a workflow',
    description:
      'Create a workflow: a graph of pre-scripts (blocks; a block with several runs them in parallel) with a trigger — manual (default), startup, or schedule.',
    input: { ...WORKFLOW_INPUT, name: z.string().min(1).max(200), reason },
    annotations: WRITES,
    run: (args, ctx) => {
      const after = validated(ctx, workflowRaw(ctx, args, null));
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere crear un workflow`,
        subtitle: `Workflow ${after.name}`,
        target: after.name,
        change: diffEntity(workflowFields(scriptNamer(ctx)), null, after),
        reason: args.reason,
        slice: { kind: 'workflow', id: after.id },
        write: saveWorkflow(ctx, after),
        data: () => ({ id: after.id }),
      });
    },
  }),
  defineTool({
    name: 'update_workflow',
    scope: 'config',
    title: 'Update a workflow',
    description:
      'Change a workflow: only the fields given change; `graph` replaces the whole graph.',
    input: { workflow: z.string(), ...WORKFLOW_INPUT, reason },
    annotations: WRITES,
    run: (args, ctx) => {
      const before = findWorkflow(ctx, args.workflow);
      const after = validated(ctx, workflowRaw(ctx, args, before));
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere cambiar un workflow`,
        subtitle: `Workflow ${before.name}`,
        target: before.name,
        change: diffEntity(workflowFields(scriptNamer(ctx)), before, after),
        reason: args.reason,
        slice: { kind: 'workflow', id: before.id },
        write: saveWorkflow(ctx, after),
      });
    },
  }),
  defineTool({
    name: 'delete_workflow',
    scope: 'config',
    title: 'Delete a workflow',
    description:
      'Delete a workflow (stopping it first if running). Can be undone.',
    input: { workflow: z.string(), reason },
    annotations: DESTRUCTIVE,
    run: (args, ctx) => {
      const before = findWorkflow(ctx, args.workflow);
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere borrar un workflow`,
        subtitle: `Workflow ${before.name}`,
        target: before.name,
        change: diffEntity(workflowFields(scriptNamer(ctx)), before, null),
        reason: args.reason,
        slice: { kind: 'workflow', id: before.id },
        write: async () =>
          handlerError(
            await ctx.changes.port.invoke('workflows:delete', {
              workflowId: before.id,
            }),
            'No se pudo borrar el workflow',
          ),
      });
    },
  }),
  defineTool({
    name: 'export_config',
    scope: 'config',
    title: 'Export the configuration',
    description:
      'The configuration as a DevBar backup file would hold it (the groups and workflows this client can see), ready for import_config.',
    input: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (_args, ctx) => {
      const exported = ctx.changes.port.exportConfig() as {
        groups: Group[];
        workflows: Workflow[];
      };
      const groups = exported.groups
        .filter((group) => ctx.groupAllowed(group.id))
        .map((group) => ({
          ...group,
          env: ctx.redact.env(group.env),
          commands: group.commands.map((c) => ({
            ...c,
            command: ctx.redact.text(c.command),
            args: c.args.map((arg) => ctx.redact.text(arg)),
            env: ctx.redact.env(c.env),
          })),
          actions: group.actions.map((a) => ({
            ...a,
            command: ctx.redact.text(a.command),
            args: a.args.map((arg) => ctx.redact.text(arg)),
            env: ctx.redact.env(a.env),
          })),
          preScripts: group.preScripts.map((s) => ({
            ...s,
            command: ctx.redact.text(s.command),
            args: s.args.map((arg) => ctx.redact.text(arg)),
            env: ctx.redact.env(s.env),
          })),
        }));
      const workflows = exported.workflows.filter((w) =>
        workflowAllowed(ctx, w),
      );
      return Promise.resolve({
        data: { ...exported, groups, workflows },
        target: 'Configuración',
        summary: `${groups.length} grupos, ${workflows.length} workflows`,
      });
    },
  }),
  defineTool({
    name: 'import_config',
    scope: 'config',
    title: 'Import a configuration',
    description:
      'Replace the WHOLE configuration (every group and workflow) with a DevBar backup (the shape export_config answers). Every service is stopped first. Can be undone.',
    input: {
      config: z.record(z.string(), z.unknown()).describe('A DevBar export.'),
      reason,
    },
    annotations: DESTRUCTIVE,
    run: (args, ctx) => {
      if (ctx.client.groups !== 'all')
        throw new ToolError(
          'Solo un asistente con acceso a todos los grupos puede importar una configuración',
        );
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere reemplazar toda la configuración`,
        subtitle: 'Importar configuración',
        target: 'Configuración',
        change: importDiff(ctx.runtime.listGroups(), args.config),
        reason: args.reason,
        slice: { kind: 'all' },
        write: async () => {
          const result = await ctx.changes.port.importConfig(args.config);
          return result.ok ? null : result.error;
        },
      });
    },
  }),
  defineTool({
    name: 'undo_last_change',
    scope: 'config',
    title: 'Undo the last change',
    description:
      "Put back what this client's latest configuration change (that was not undone yet) replaced.",
    input: { reason },
    annotations: DESTRUCTIVE,
    run: async (args, ctx) => {
      const entry = ctx.lastUndo();
      if (!entry?.undoToken)
        throw new ToolError('No hay ningún cambio tuyo que se pueda deshacer');
      const diff = (entry.diff ?? []).map((line) => ({
        ...line,
        kind:
          line.kind === 'add'
            ? ('del' as const)
            : line.kind === 'del'
              ? ('add' as const)
              : line.kind,
      }));
      await ctx.confirmChange({
        title: `${ctx.client.name} quiere deshacer un cambio`,
        subtitle: `${entry.tool} · ${entry.target}`,
        risk: 'executes',
        diff,
        reason: args.reason,
      });
      const result = await ctx.changes.restore(entry.undoToken);
      if (!result.ok)
        throw new ToolError(
          result.error ?? 'No se pudo deshacer',
          'error',
          entry.target,
        );
      ctx.retireUndo(entry.id);
      return {
        data: { ok: true, undone: entry.tool, target: entry.target },
        target: entry.target,
        summary: `deshecho ${entry.tool}`,
        diff,
      };
    },
  }),
];
