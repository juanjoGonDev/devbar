import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  McpClient,
  McpConfirmPolicy,
} from '../../ipc-contract/mcp-api.js';
import type { ConfirmDesk, ConfirmOutcome } from './confirm-desk.js';
import {
  createRedactor,
  knownSecrets,
  NO_REDACTION,
  type Redactor,
} from './redact.js';
import type { SessionDeps } from './session.js';
import {
  ToolError,
  type ConfigProposal,
  type RunConfirmation,
  type ToolContext,
  type ToolDef,
  type ToolOutcome,
} from './tools/tool-kit.js';

/**
 * One tool call of a session, end to end: the permission check (again, on
 * every call), the usage counter, the per-call context the tool runs with
 * (its client's group filter, redactor and confirmations) and the audit
 * entry — recorded as `pending` while the user is asked, then settled with
 * the outcome. A tool's `ToolError` reaches the assistant as its error text;
 * anything else is reported as an internal error.
 */

const MAX_SUMMARY = 200;

export const PERMISSION_DENIED = (tool: string): string =>
  `Este asistente no tiene permiso para «${tool}» en DevBar (Ajustes › MCP).`;

const OUTCOME_ERRORS: Record<Exclude<ConfirmOutcome, 'applied'>, string> = {
  rejected: 'El usuario lo ha rechazado en DevBar.',
  expired: 'Nadie lo confirmó en DevBar en 60 s, así que se ha rechazado.',
  cancelled: 'El servidor MCP de DevBar se ha detenido antes de confirmarlo.',
};

export function text(value: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

export const isAllowed = (client: McpClient | null): client is McpClient =>
  client?.status === 'allowed';

export interface Calls {
  call: (def: ToolDef, args: unknown) => Promise<CallToolResult>;
  contextFor: (
    client: McpClient,
    pendingAudit: { id: string | null },
    tool: string,
  ) => ToolContext;
}

export function createCalls(
  deps: SessionDeps,
  current: () => McpClient | null,
): Calls {
  const allowed = isAllowed;
  const contextFor = (
    client: McpClient,
    pendingAudit: { id: string | null },
    tool: string,
  ): ToolContext => {
    const groupAllowed = (groupId: string): boolean =>
      client.groups === 'all' || client.groups.includes(groupId);
    const redact: Redactor = client.redactSecrets
      ? createRedactor(knownSecrets(deps.runtime.listGroups()))
      : NO_REDACTION;
    const ask = async (
      request: Parameters<ConfirmDesk['ask']>[0],
      target: string,
      diff: ConfigProposal['diff'] | undefined,
    ): Promise<void> => {
      const auditDiff = diff
        ? diff.map((line) => ({
            ...line,
            text: auditRedactor().text(line.text),
          }))
        : undefined;
      const entry = deps.audit.record({
        clientId: client.id,
        clientName: client.name,
        tool,
        target,
        result: 'pending',
        summary: 'Esperando confirmación en DevBar',
        ...(auditDiff ? { diff: auditDiff } : {}),
      });
      pendingAudit.id = entry.id;
      const outcome = await deps.desk.ask(request).outcome;
      if (outcome !== 'applied')
        throw new ToolError(OUTCOME_ERRORS[outcome], 'rejected', target);
    };
    /** Asks per the client's policy: never, once per key, or always. */
    const gate = async (
      policy: McpConfirmPolicy,
      key: string,
      asking: () => Promise<void>,
    ): Promise<void> => {
      const once = `${client.id}|${key}`;
      if (policy === 'never') return;
      if (policy === 'first' && deps.firstApprovals.has(once)) return;
      await asking();
      if (policy === 'first') deps.firstApprovals.add(once);
    };
    return {
      client,
      runtime: deps.runtime,
      redact,
      groups: () =>
        deps.runtime.listGroups().filter((group) => groupAllowed(group.id)),
      groupAllowed,
      confirmRun: (question: RunConfirmation) =>
        gate(client.confirm[question.scope], question.key, () =>
          ask(
            {
              clientName: client.name,
              title: question.title,
              subtitle: question.subtitle,
              risk: 'executes',
              diff: [],
              ...(question.reason ? { reason: question.reason } : {}),
            },
            question.subtitle,
            undefined,
          ),
        ),
      confirmChange: (proposal: ConfigProposal) =>
        gate(client.confirm.config, `cfg:${tool}:${proposal.subtitle}`, () =>
          ask(
            {
              clientName: client.name,
              title: proposal.title,
              subtitle: proposal.subtitle,
              risk: proposal.risk,
              diff: proposal.diff,
              ...(proposal.reason ? { reason: proposal.reason } : {}),
            },
            proposal.subtitle,
            proposal.diff,
          ),
        ),
      now: () => deps.now(),
      sleep: (ms) => deps.sleep(ms),
      changes: deps.changes,
      lastUndo: () => deps.audit.latestUndoable(client.id),
      retireUndo: (entryId) => {
        deps.audit.update(entryId, { undoToken: undefined });
      },
    };
  };

  /** Masks env values and secret shapes in what the audit keeps. */
  const auditRedactor = (): Redactor =>
    createRedactor(knownSecrets(deps.runtime.listGroups()));

  const settle = (
    client: McpClient,
    tool: string,
    pendingAudit: { id: string | null },
    entry: {
      target: string;
      result: 'ok' | 'warning' | 'error' | 'rejected';
      summary: string;
      diff?: ToolOutcome['diff'];
      undoToken?: string | undefined;
    },
  ): void => {
    const summary = entry.summary.slice(0, MAX_SUMMARY);
    const diff = entry.diff?.map((line) => ({
      ...line,
      text: auditRedactor().text(line.text),
    }));
    const fields = {
      target: entry.target,
      result: entry.result,
      summary,
      ...(diff ? { diff } : {}),
      ...(entry.undoToken ? { undoToken: entry.undoToken } : {}),
    };
    if (pendingAudit.id) deps.audit.update(pendingAudit.id, fields);
    else
      deps.audit.record({
        clientId: client.id,
        clientName: client.name,
        tool,
        ...fields,
      });
  };

  const call = async (def: ToolDef, args: unknown): Promise<CallToolResult> => {
    const client = current();
    if (!allowed(client) || !client.scopes[def.scope]) {
      if (client)
        deps.audit.record({
          clientId: client.id,
          clientName: client.name,
          tool: def.name,
          target: '',
          result: 'rejected',
          summary: 'Sin permiso',
        });
      return text(PERMISSION_DENIED(def.name), true);
    }
    deps.clients.recordCall(client.id);
    const pendingAudit = { id: null as string | null };
    try {
      const outcome = await def.run(
        args as never,
        contextFor(client, pendingAudit, def.name),
      );
      settle(client, def.name, pendingAudit, {
        target: outcome.target,
        result: outcome.result ?? 'ok',
        summary: outcome.summary,
        diff: outcome.diff,
        undoToken: outcome.undoToken,
      });
      return text(outcome.data, outcome.result === 'error');
    } catch (error) {
      const failure =
        error instanceof ToolError
          ? error
          : new ToolError(
              `Error de DevBar: ${error instanceof Error ? error.message : String(error)}`,
            );
      settle(client, def.name, pendingAudit, {
        target: failure.target,
        result: failure.result,
        summary: failure.message,
      });
      return text(failure.message, true);
    }
  };

  return { call, contextFor };
}
