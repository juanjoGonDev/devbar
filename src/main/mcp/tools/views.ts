import { z } from 'zod';
import {
  makeActionId,
  makeCommandId,
  makePreScriptId,
} from '../../../compound-id.js';
import type { Group, LogEntry } from '../../../domain-types.js';
import type { GroupState } from '../../../ipc-contract.js';
import { findGroup, ToolError, type ToolContext } from './tool-kit.js';

/**
 * How DevBar's state looks to an assistant: groups (env values through the
 * client's redactor), live status, log lines, and the shared log filters.
 */

export function groupView(ctx: ToolContext, group: Group): unknown {
  const env = (entries: Group['env']) =>
    ctx.redact.env(entries).map((entry) => ({
      key: entry.key,
      value: entry.value,
      enabled: entry.enabled,
    }));
  return {
    id: group.id,
    name: group.name,
    icon: group.icon,
    iconColor: group.iconColor,
    folder: group.path,
    mode: group.mode,
    hiddenInTray: group.hiddenInTray,
    env: env(group.env),
    commands: group.commands.map((command) => ({
      id: command.id,
      name: command.name,
      icon: command.icon,
      iconColor: command.iconColor,
      command: ctx.redact.text(command.command),
      args: command.args.map((arg) => ctx.redact.text(arg)),
      cwd: command.cwd,
      env: env(command.env),
      autoStart: command.autoStart,
      confirm: command.confirm,
      schedule: command.schedule,
      link: command.link ?? { mode: 'auto' },
    })),
    actions: group.actions.map((action) => ({
      id: action.id,
      name: action.name,
      icon: action.icon,
      iconColor: action.iconColor,
      command: ctx.redact.text(action.command),
      args: action.args.map((arg) => ctx.redact.text(arg)),
      env: env(action.env),
      inheritGroupEnv: action.inheritGroupEnv,
      confirm: action.confirm,
      schedule: action.schedule,
    })),
    preScripts: group.preScripts.map((script) => ({
      id: script.id,
      name: script.name,
      command: ctx.redact.text(script.command),
      args: script.args.map((arg) => ctx.redact.text(arg)),
      env: env(script.env),
      inheritGroupEnv: script.inheritGroupEnv,
      timeoutMs: script.timeoutMs,
    })),
  };
}

export function visibleStates(
  ctx: ToolContext,
  groupRef?: string,
): GroupState[] {
  const only = groupRef === undefined ? null : findGroup(ctx, groupRef).id;
  return ctx.runtime
    .groupStates()
    .filter((state) => ctx.groupAllowed(state.groupId))
    .filter((state) => only === null || state.groupId === only);
}

export function statusView(state: GroupState): unknown {
  return {
    id: state.groupId,
    name: state.group.name,
    branch: state.currentBranch,
    health: state.color,
    lastError: state.lastError,
    commands: state.commands.map((command) => {
      const def = state.group.commands.find((c) => c.id === command.commandId);
      return {
        id: command.commandId,
        name: def?.name ?? command.commandId,
        status: command.status,
        startedAt: command.startedAt,
        warnings: command.warnCount,
        errors: command.errorCount,
        lastError: command.lastError,
        ports: command.ports.map((port) => port.port),
      };
    }),
    actions: state.actions.map((action) => {
      const def = state.group.actions.find((a) => a.id === action.actionId);
      return {
        id: action.actionId,
        name: def?.name ?? action.actionId,
        status: action.status,
        lastExitCode: action.lastExitCode,
        lastFinishedAt: action.lastFinishedAt,
      };
    }),
  };
}

/** The process id of a command, action or pre-script named in a group. */
export function processOf(
  group: Group,
  target: string,
): { processId: string; name: string } {
  const command =
    group.commands.find((c) => c.id === target) ??
    group.commands.find((c) => c.name.toLowerCase() === target.toLowerCase());
  if (command)
    return {
      processId: makeCommandId(group.id, command.id),
      name: command.name,
    };
  const action =
    group.actions.find((a) => a.id === target) ??
    group.actions.find((a) => a.name.toLowerCase() === target.toLowerCase());
  if (action)
    return { processId: makeActionId(group.id, action.id), name: action.name };
  const script =
    group.preScripts.find((s) => s.id === target) ??
    group.preScripts.find((s) => s.name.toLowerCase() === target.toLowerCase());
  if (script)
    return {
      processId: makePreScriptId(group.id, script.id),
      name: script.name,
    };
  throw new ToolError(
    `El grupo «${group.name}» no tiene ningún comando, acción ni pre-script «${target}»`,
  );
}

export const since = z
  .union([z.number(), z.string()])
  .optional()
  .describe('Only lines at or after this moment: epoch ms or an ISO date.');

export function sinceMs(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new ToolError(`Fecha no válida: «${value}»`);
  return ms;
}

export function lineView(ctx: ToolContext, entry: LogEntry): unknown {
  return {
    at: new Date(entry.ts).toISOString(),
    stream: entry.stream,
    level: entry.level,
    line: ctx.redact.text(entry.line),
  };
}

export const level = z
  .enum(['all', 'warn', 'error'])
  .optional()
  .describe('`warn` keeps warnings and errors, `error` only errors.');

export function levelMatches(
  entry: LogEntry,
  wanted: 'all' | 'warn' | 'error' | undefined,
): boolean {
  if (!wanted || wanted === 'all') return true;
  if (wanted === 'error') return entry.level === 'error';
  return entry.level === 'warn' || entry.level === 'error';
}
