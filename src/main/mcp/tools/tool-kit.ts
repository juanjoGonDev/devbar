import type { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type {
  Action,
  Command,
  Group,
  Workflow,
} from '../../../domain-types.js';
import type {
  McpAuditResult,
  McpClient,
  McpDiffLine,
  McpRisk,
  McpScopes,
} from '../../../ipc-contract/mcp-api.js';
import type { Redactor } from '../redact.js';
import type { McpRuntime } from '../runtime.js';

/**
 * What every MCP tool of DevBar is made of: its scope (the permission that
 * unlocks it), a zod input schema the SDK validates every call against, and
 * a `run` that answers with data for the assistant plus the one-line target
 * and summary the audit log keeps. A tool never checks permissions itself:
 * the session (src/main/mcp/session.ts) does, on every call.
 */

type Shape = Record<string, z.ZodType>;

/** A failure the assistant should read: shown to it as the tool's error. */
export class ToolError extends Error {
  constructor(
    message: string,
    /** `rejected`: the user (or the timeout) said no. */
    readonly result: Extract<McpAuditResult, 'error' | 'rejected'> = 'error',
    readonly target = '',
  ) {
    super(message);
  }
}

export interface ToolOutcome {
  data: unknown;
  target: string;
  summary: string;
  result?: Extract<McpAuditResult, 'ok' | 'warning' | 'error'>;
  diff?: McpDiffLine[];
  undoToken?: string;
}

/** A question for the user before a control or workflow call goes ahead. */
export interface RunConfirmation {
  scope: 'control' | 'workflows';
  /** Stable key for «ask the first time» (`cmd:<group>:<command>`…). */
  key: string;
  title: string;
  subtitle: string;
  reason?: string | undefined;
}

/** A configuration change, before it is applied. */
export interface ConfigProposal {
  title: string;
  subtitle: string;
  risk: McpRisk;
  diff: McpDiffLine[];
  reason?: string | undefined;
}

export interface ToolContext {
  client: McpClient;
  runtime: McpRuntime;
  redact: Redactor;
  /** The groups this client may see, in the user's order. */
  groups(): Group[];
  groupAllowed(groupId: string): boolean;
  /** Throws `ToolError('rejected')` when the user says no. */
  confirmRun(question: RunConfirmation): Promise<void>;
  /** Waits for the user's OK on a config change; throws when refused. */
  confirmChange(proposal: ConfigProposal): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ToolDef<S extends Shape = Shape> {
  name: string;
  scope: keyof McpScopes;
  title: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Keeps each tool's own argument type while listing them together. */
export function defineTool<S extends Shape>(def: ToolDef<S>): ToolDef {
  return def;
}

// ── Lookups every tool family shares ─────────────────────────────────────

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function byRef<T extends { id: string; name: string }>(
  items: readonly T[],
  ref: string,
): T | undefined {
  return (
    items.find((item) => item.id === ref) ??
    items.find((item) => sameName(item.name, ref))
  );
}

/** A group this client may touch, by id or name. */
export function findGroup(ctx: ToolContext, ref: string): Group {
  const group = byRef(ctx.groups(), ref);
  if (!group)
    throw new ToolError(`No hay ningún grupo «${ref}» al que tengas acceso`);
  return group;
}

export function findCommand(group: Group, ref: string): Command {
  const command = byRef(group.commands, ref);
  if (!command)
    throw new ToolError(
      `El grupo «${group.name}» no tiene el comando «${ref}»`,
    );
  return command;
}

export function findAction(group: Group, ref: string): Action {
  const action = byRef(group.actions, ref);
  if (!action)
    throw new ToolError(`El grupo «${group.name}» no tiene la acción «${ref}»`);
  return action;
}

/** Whether every script a workflow runs belongs to a group the client sees. */
export function workflowAllowed(ctx: ToolContext, workflow: Workflow): boolean {
  return workflow.graph.blocks.every((block) =>
    block.scripts.every((ref) => ctx.groupAllowed(ref.groupId)),
  );
}

export function findWorkflow(ctx: ToolContext, ref: string): Workflow {
  const visible = ctx.runtime
    .workflowEntries()
    .map((entry) => entry.workflow)
    .filter((workflow) => workflowAllowed(ctx, workflow));
  const workflow = byRef(visible, ref);
  if (!workflow)
    throw new ToolError(`No hay ningún workflow «${ref}» al que tengas acceso`);
  return workflow;
}

/** «Back › Normal». */
export function label(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' › ');
}
