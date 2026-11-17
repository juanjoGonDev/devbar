import { z } from 'zod';
import { makeActionId, makeCommandId } from '../../../compound-id.js';
import type { Group } from '../../../domain-types.js';
import {
  defineTool,
  findAction,
  findCommand,
  findGroup,
  findWorkflow,
  label,
  ToolError,
  type ToolContext,
  type ToolDef,
} from './tool-kit.js';
import { lineView } from './views.js';

/**
 * The `control` and `workflows` scopes: start, stop and restart commands, run
 * actions (optionally waiting for their exit code), wait for a port, and run
 * or stop workflows. Each goes through the app's own runtime actions — the
 * single-mode rule and a command's «Confirmar antes de arrancar» still apply
 * — and, first, through the client's confirmation policy (`confirmRun`).
 */

const POLL_MS = 250;
const MAX_WAIT_S = 600;
const MAX_PORT_WAIT_S = 300;
const DEFAULT_TAIL = 50;

const reason = z
  .string()
  .max(500)
  .optional()
  .describe('Why, in a few words: shown to the user if DevBar asks first.');

const CANCELLED = 'Cancelado en el diálogo de confirmación de DevBar.';

function commandTarget(ctx: ToolContext, groupRef: string, commandRef: string) {
  const group = findGroup(ctx, groupRef);
  const command = findCommand(group, commandRef);
  return {
    group,
    command,
    processId: makeCommandId(group.id, command.id),
    target: label(group.name, command.name),
  };
}

const NOUNS = {
  comando: 'un comando',
  acción: 'una acción',
  workflow: 'un workflow',
} as const;

/** The client's confirmation policy, before anything runs. */
function ask(
  ctx: ToolContext,
  verb: string,
  noun: keyof typeof NOUNS,
  subtitle: string,
  key: string,
  why: string | undefined,
): Promise<void> {
  return ctx.confirmRun({
    scope: noun === 'workflow' ? 'workflows' : 'control',
    key: `${verb}:${key}`,
    title: `${ctx.client.name} quiere ${verb} ${NOUNS[noun]}`,
    subtitle,
    reason: why,
  });
}

const groupSubtitle = (group: Group, noun: string, name: string): string =>
  `Grupo ${group.name} · ${noun} ${name}`;

const settled = (status: string): boolean =>
  status !== 'running' && status !== 'starting' && status !== 'stopping';

export const CONTROL_TOOLS: readonly ToolDef[] = [
  defineTool({
    name: 'start',
    scope: 'control',
    title: 'Start a command',
    description:
      'Start a command (a long-running service). In a single-mode group the other running command stops first.',
    input: { group: z.string(), command: z.string(), reason },
    annotations: { destructiveHint: false, openWorldHint: false },
    run: async (args, ctx) => {
      const t = commandTarget(ctx, args.group, args.command);
      await ask(
        ctx,
        'arrancar',
        'comando',
        groupSubtitle(t.group, 'comando', t.command.name),
        t.processId,
        args.reason,
      );
      const result = await ctx.runtime.startProcess(t.processId);
      if (result.cancelled)
        throw new ToolError(CANCELLED, 'rejected', t.target);
      if (!result.ok)
        throw new ToolError(
          result.error ?? 'No se pudo arrancar',
          'error',
          t.target,
        );
      return {
        data: { ok: true, status: 'running' },
        target: t.target,
        summary: 'arrancado',
      };
    },
  }),
  defineTool({
    name: 'stop',
    scope: 'control',
    title: 'Stop a command',
    description: 'Stop a running command and wait until it has exited.',
    input: { group: z.string(), command: z.string(), reason },
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (args, ctx) => {
      const t = commandTarget(ctx, args.group, args.command);
      await ask(
        ctx,
        'parar',
        'comando',
        groupSubtitle(t.group, 'comando', t.command.name),
        t.processId,
        args.reason,
      );
      const result = await ctx.runtime.stopProcess(t.processId);
      if (!result.ok)
        throw new ToolError(
          result.error ?? 'No se pudo parar',
          'error',
          t.target,
        );
      return {
        data: { ok: true, status: 'stopped' },
        target: t.target,
        summary: 'parado',
      };
    },
  }),
  defineTool({
    name: 'restart',
    scope: 'control',
    title: 'Restart a command',
    description: 'Stop a command (if running) and start it again.',
    input: { group: z.string(), command: z.string(), reason },
    annotations: { destructiveHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const t = commandTarget(ctx, args.group, args.command);
      await ask(
        ctx,
        'reiniciar',
        'comando',
        groupSubtitle(t.group, 'comando', t.command.name),
        t.processId,
        args.reason,
      );
      const stopped = await ctx.runtime.stopProcess(t.processId);
      if (!stopped.ok)
        throw new ToolError(
          stopped.error ?? 'No se pudo parar',
          'error',
          t.target,
        );
      const started = await ctx.runtime.startProcess(t.processId);
      if (started.cancelled)
        throw new ToolError(CANCELLED, 'rejected', t.target);
      if (!started.ok)
        throw new ToolError(
          started.error ?? 'No se pudo arrancar',
          'error',
          t.target,
        );
      return {
        data: { ok: true, status: 'running' },
        target: t.target,
        summary: 'reiniciado',
      };
    },
  }),
  defineTool({
    name: 'run_action',
    scope: 'control',
    title: 'Run an action',
    description:
      'Run an action (a one-off task). With `wait`, wait up to that many seconds for it to finish and return its exit code and the last log lines.',
    input: {
      group: z.string(),
      action: z.string(),
      wait: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_S)
        .optional()
        .describe('Seconds to wait for the exit code (0 = do not wait).'),
      tail: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          `Log lines to return when waiting (default ${DEFAULT_TAIL}).`,
        ),
      reason,
    },
    annotations: { destructiveHint: false, openWorldHint: false },
    run: async (args, ctx) => {
      const group = findGroup(ctx, args.group);
      const action = findAction(group, args.action);
      const target = label(group.name, action.name);
      const processId = makeActionId(group.id, action.id);
      await ask(
        ctx,
        'lanzar',
        'acción',
        groupSubtitle(group, 'acción', action.name),
        processId,
        args.reason,
      );
      const result = await ctx.runtime.runAction(group.id, action.id);
      if (result.cancelled) throw new ToolError(CANCELLED, 'rejected', target);
      if (!result.ok)
        throw new ToolError(
          result.error ?? 'No se pudo lanzar',
          'error',
          target,
        );
      if (!args.wait)
        return {
          data: { ok: true, status: 'running' },
          target,
          summary: 'lanzada',
        };
      const deadline = ctx.now() + args.wait * 1000;
      let state = ctx.runtime.processState(processId);
      while (!settled(state.status) && ctx.now() < deadline) {
        await ctx.sleep(POLL_MS);
        state = ctx.runtime.processState(processId);
      }
      const logs = ctx.runtime
        .logs(processId)
        .slice(-(args.tail ?? DEFAULT_TAIL))
        .map((entry) => lineView(ctx, entry));
      if (!settled(state.status))
        return {
          data: { ok: true, status: 'running', finished: false, logs },
          target,
          summary: `sigue en marcha tras ${args.wait} s`,
          result: 'warning',
        };
      const exitCode = state.lastExitCode;
      return {
        data: {
          ok: exitCode === 0,
          finished: true,
          status: state.status,
          exitCode,
          logs,
        },
        target,
        summary: `código de salida ${String(exitCode)}`,
        result: exitCode === 0 ? 'ok' : 'error',
      };
    },
  }),
  defineTool({
    name: 'wait_for_port',
    scope: 'control',
    title: 'Wait for a port',
    description:
      'Wait until a running command listens on a TCP port (any, or the one given), up to `timeout` seconds; answers with its ports.',
    input: {
      group: z.string(),
      command: z.string(),
      port: z.number().int().min(1).max(65535).optional(),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_PORT_WAIT_S)
        .optional()
        .describe('Seconds (default 30).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const t = commandTarget(ctx, args.group, args.command);
      const deadline = ctx.now() + (args.timeout ?? 30) * 1000;
      const portsNow = () =>
        ctx.runtime
          .groupStates()
          .find((state) => state.groupId === t.group.id)
          ?.commands.find((command) => command.commandId === t.command.id)
          ?.ports ?? [];
      const ready = () => {
        const ports = portsNow();
        return args.port === undefined
          ? ports.length > 0
          : ports.some((p) => p.port === args.port);
      };
      while (!ready() && ctx.now() < deadline) await ctx.sleep(POLL_MS);
      const ports = portsNow();
      if (!ready())
        throw new ToolError(
          `«${t.target}» no escucha en ${args.port === undefined ? 'ningún puerto' : `el puerto ${args.port}`} tras ${args.timeout ?? 30} s`,
          'error',
          t.target,
        );
      return {
        data: ports,
        target: t.target,
        summary: ports.map((p) => `:${p.port}`).join(', '),
      };
    },
  }),
  defineTool({
    name: 'run_workflow',
    scope: 'workflows',
    title: 'Run a workflow',
    description:
      'Run a workflow (its pre-scripts, in graph order). With `wait`, answer only when the run has finished, with its result.',
    input: { workflow: z.string(), wait: z.boolean().optional(), reason },
    annotations: { destructiveHint: false, openWorldHint: false },
    run: async (args, ctx) => {
      const workflow = findWorkflow(ctx, args.workflow);
      await ask(
        ctx,
        'lanzar',
        'workflow',
        `Workflow ${workflow.name}`,
        `wf:${workflow.id}`,
        args.reason,
      );
      const running = ctx.runtime.runWorkflow(workflow.id);
      if (!args.wait) {
        running.catch(() => undefined);
        return {
          data: { ok: true, started: true },
          target: workflow.name,
          summary: 'lanzado',
        };
      }
      const result = (await running) as {
        ok?: boolean;
        error?: string;
        cancelled?: boolean;
      };
      const state = ctx.runtime.workflowRunState(workflow.id);
      if (result.cancelled)
        throw new ToolError(CANCELLED, 'rejected', workflow.name);
      const status = state?.status ?? (result.ok ? 'success' : 'error');
      return {
        data: {
          ok: result.ok === true,
          status,
          error: result.error,
          run: state,
        },
        target: workflow.name,
        summary: status,
        result:
          status === 'success'
            ? 'ok'
            : status === 'warning'
              ? 'warning'
              : 'error',
      };
    },
  }),
  defineTool({
    name: 'stop_workflow',
    scope: 'workflows',
    title: 'Stop a workflow',
    description: 'Stop a running workflow: its running scripts are cancelled.',
    input: { workflow: z.string(), reason },
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (args, ctx) => {
      const workflow = findWorkflow(ctx, args.workflow);
      await ask(
        ctx,
        'detener',
        'workflow',
        `Workflow ${workflow.name}`,
        `wf:${workflow.id}`,
        args.reason,
      );
      const result = ctx.runtime.stopWorkflow(workflow.id);
      if (!result.ok)
        throw new ToolError(
          result.error ?? 'No se pudo detener',
          'error',
          workflow.name,
        );
      return { data: { ok: true }, target: workflow.name, summary: 'detenido' };
    },
  }),
];
