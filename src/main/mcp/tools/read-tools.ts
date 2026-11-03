import { z } from 'zod';
import {
  makeActionId,
  makeCommandId,
  makePreScriptId,
} from '../../../compound-id.js';
import {
  defineTool,
  findGroup,
  findWorkflow,
  label,
  ToolError,
  workflowAllowed,
  type ToolDef,
} from './tool-kit.js';
import {
  groupView,
  level,
  levelMatches,
  lineView,
  processOf,
  since,
  sinceMs,
  statusView,
  visibleStates,
} from './views.js';

/**
 * The `read` scope: what is configured, what is running, on which ports, and
 * what it logged. Log lines go through the client's redactor before they
 * leave, and the audit log only keeps how many lines were read, never them.
 */

const MAX_TAIL = 2000;
const DEFAULT_TAIL = 100;
const MAX_MATCHES = 500;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const READ_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: 'list_groups',
    scope: 'read',
    title: 'List groups',
    description:
      'Every DevBar group this client can see, with its folder, env, commands (long-running services), actions (one-off tasks) and pre-scripts (workflow steps). Ids and names are both accepted wherever a tool asks for a group, command, action or pre-script.',
    input: {},
    annotations: READ_ONLY,
    run: (_args, ctx) => {
      const groups = ctx.groups();
      return Promise.resolve({
        data: groups.map((group) => groupView(ctx, group)),
        target: 'Todos los grupos',
        summary: `${groups.length} grupos`,
      });
    },
  }),
  defineTool({
    name: 'get_status',
    scope: 'read',
    title: 'Get status',
    description:
      'Live state of each command and action: running/stopped/error, start time, warning and error counts, last error, listening ports, and the git branch of the group.',
    input: {
      group: z
        .string()
        .optional()
        .describe('Group id or name; all when omitted.'),
    },
    annotations: READ_ONLY,
    run: async ({ group }, ctx) => {
      const states = await Promise.all(
        visibleStates(ctx, group).map(async (state) => ({
          ...state,
          currentBranch: await ctx.runtime.currentBranch(state.groupId),
        })),
      );
      const running = states
        .flatMap((s) => s.commands)
        .filter((c) => c.status === 'running').length;
      return {
        data: states.map(statusView),
        target: group ? (states[0]?.group.name ?? group) : 'Todos los grupos',
        summary: `${running} en marcha`,
      };
    },
  }),
  defineTool({
    name: 'get_ports',
    scope: 'read',
    title: 'Get ports',
    description:
      'The TCP ports running commands listen on, with their URL, kind (web/http/other) and whether the LAN can reach them.',
    input: {
      group: z
        .string()
        .optional()
        .describe('Group id or name; all when omitted.'),
    },
    annotations: READ_ONLY,
    run: ({ group }, ctx) => {
      const rows = visibleStates(ctx, group).flatMap((state) =>
        state.commands
          .filter((command) => command.ports.length > 0)
          .map((command) => ({
            group: state.group.name,
            command:
              state.group.commands.find((c) => c.id === command.commandId)
                ?.name ?? command.commandId,
            ports: command.ports,
          })),
      );
      const ports = rows.flatMap((row) => row.ports.map((p) => `:${p.port}`));
      return Promise.resolve({
        data: rows,
        target: group ?? 'Todos los grupos',
        summary: ports.length ? ports.join(', ') : 'sin puertos',
      });
    },
  }),
  defineTool({
    name: 'read_logs',
    scope: 'read',
    title: 'Read logs',
    description:
      'The last lines a command, action or pre-script printed (what DevBar keeps in memory for it).',
    input: {
      group: z.string().describe('Group id or name.'),
      target: z.string().describe('Command, action or pre-script id or name.'),
      tail: z
        .number()
        .int()
        .min(1)
        .max(MAX_TAIL)
        .optional()
        .describe(`How many lines from the end (default ${DEFAULT_TAIL}).`),
      level,
      since,
    },
    annotations: READ_ONLY,
    run: (args, ctx) => {
      const group = findGroup(ctx, args.group);
      const { processId, name } = processOf(group, args.target);
      const from = sinceMs(args.since);
      const lines = ctx.runtime
        .logs(processId)
        .filter((entry) => levelMatches(entry, args.level))
        .filter((entry) => from === null || entry.ts >= from)
        .slice(-(args.tail ?? DEFAULT_TAIL));
      return Promise.resolve({
        data: lines.map((entry) => lineView(ctx, entry)),
        target: label(group.name, name),
        summary: `${lines.length} líneas`,
      });
    },
  }),
  defineTool({
    name: 'search_logs',
    scope: 'read',
    title: 'Search logs',
    description:
      'Find lines matching a text (or a regular expression) across the logs of every command, action and pre-script this client can see, or of one group or target.',
    input: {
      query: z
        .string()
        .min(1)
        .max(500)
        .describe('Text, or a regex with `regex: true`.'),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      group: z.string().optional().describe('Group id or name.'),
      target: z
        .string()
        .optional()
        .describe('Command, action or pre-script id or name (needs `group`).'),
      level,
      since,
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_MATCHES)
        .optional()
        .describe('Most recent matches to return (default 100).'),
    },
    annotations: READ_ONLY,
    run: (args, ctx) => {
      let matcher: RegExp;
      try {
        matcher = new RegExp(
          args.regex
            ? args.query
            : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          args.caseSensitive ? '' : 'i',
        );
      } catch {
        throw new ToolError(`Expresión regular no válida: «${args.query}»`);
      }
      if (args.target && !args.group)
        throw new ToolError('Indica también el grupo del objetivo');
      const groups = args.group ? [findGroup(ctx, args.group)] : ctx.groups();
      const sources = groups.flatMap((group) => {
        if (args.target) {
          const { processId, name } = processOf(group, args.target);
          return [{ group, processId, name }];
        }
        return [
          ...group.commands.map((c) => ({
            group,
            processId: makeCommandId(group.id, c.id),
            name: c.name,
          })),
          ...group.actions.map((a) => ({
            group,
            processId: makeActionId(group.id, a.id),
            name: a.name,
          })),
          ...group.preScripts.map((s) => ({
            group,
            processId: makePreScriptId(group.id, s.id),
            name: s.name,
          })),
        ];
      });
      const from = sinceMs(args.since);
      const matches = sources
        .flatMap((source) =>
          ctx.runtime
            .logs(source.processId)
            .filter((entry) => levelMatches(entry, args.level))
            .filter((entry) => from === null || entry.ts >= from)
            .filter((entry) => matcher.test(entry.line))
            .map((entry) => ({ source, entry })),
        )
        .sort((a, b) => a.entry.ts - b.entry.ts)
        .slice(-(args.limit ?? 100));
      return Promise.resolve({
        data: matches.map(({ source, entry }) => ({
          group: source.group.name,
          target: source.name,
          ...(lineView(ctx, entry) as object),
        })),
        target: label(
          args.group ? groups[0]?.name : 'Todos los grupos',
          args.target,
          `«${args.query}»`,
        ),
        summary: `${matches.length} líneas`,
      });
    },
  }),
  defineTool({
    name: 'list_workflows',
    scope: 'read',
    title: 'List workflows',
    description:
      'Every workflow (a graph of pre-scripts with a trigger: manual, startup or schedule) this client can see, with its last run, next scheduled run and whether it is running.',
    input: {},
    annotations: READ_ONLY,
    run: (_args, ctx) => {
      const entries = ctx.runtime
        .workflowEntries()
        .filter((entry) => workflowAllowed(ctx, entry.workflow));
      return Promise.resolve({
        data: entries.map((entry) => ({
          id: entry.workflow.id,
          name: entry.workflow.name,
          enabled: entry.workflow.enabled,
          trigger: entry.workflow.trigger,
          graph: entry.workflow.graph,
          scripts: entry.scriptCount,
          lastRun: entry.lastRun,
          nextRunAt: entry.nextRunAt,
          running: entry.running,
        })),
        target: 'Todos los workflows',
        summary: `${entries.length} workflows`,
      });
    },
  }),
  defineTool({
    name: 'workflow_status',
    scope: 'read',
    title: 'Workflow status',
    description:
      'The latest run of one workflow this session: status of each block and script, exit codes and timings.',
    input: { workflow: z.string().describe('Workflow id or name.') },
    annotations: READ_ONLY,
    run: ({ workflow: ref }, ctx) => {
      const workflow = findWorkflow(ctx, ref);
      const state = ctx.runtime.workflowRunState(workflow.id);
      return Promise.resolve({
        data: state ?? { workflowId: workflow.id, status: 'never-run' },
        target: workflow.name,
        summary: state ? state.status : 'sin ejecuciones',
      });
    },
  }),
];
