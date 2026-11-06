import type { McpSettings } from '../../domain-types.js';
import type {
  McpAuditEntry,
  McpAuditPage,
  McpAuditPageQuery,
  McpClientPatch,
  McpConfirmAnswer,
  McpConfirmRequest,
  McpConnectCommands,
  McpMutationResult,
  McpScopeKey,
  McpScopes,
  McpState,
} from '../../ipc-contract/mcp-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import { errorMessage } from '../ipc-validators.js';
import type { AuditLog } from './audit-log.js';
import type { ClientStore, ClientStoreResult } from './client-store.js';
import type { ConfirmDesk } from './confirm-desk.js';

/**
 * Settings › MCP as main sees it: the switch, the client list, the audit log,
 * the pending confirmations and undo. This is the surface the `mcp:*` IPC
 * handlers call (src/main/ipc/mcp-ipc.ts); the server that assistants talk to
 * shares the same client store, audit log and confirmation desk, so a change
 * made here reaches every live session at once.
 */

/** The local endpoint assistants connect through. */
export interface McpEndpoint {
  /** Rejects, with the reason, when it cannot listen. */
  start(): Promise<void>;
  stop(): Promise<void>;
  listening(): boolean;
}

export interface McpControlDeps {
  settings: {
    get(): McpSettings;
    save(next: McpSettings): void;
  };
  clients: ClientStore;
  audit: AuditLog;
  /** The tool catalog: which family each tool the log names belongs to. */
  tools: readonly { name: string; scope: McpScopeKey }[];
  desk: ConfirmDesk;
  endpoint: McpEndpoint;
  connectCommand(): McpConnectCommands;
  /** Puts back what the change behind this audit entry replaced. */
  restore(entry: McpAuditEntry): Promise<SimpleResult>;
  /** The state changed: push it to the windows. */
  changed(state: McpState): void;
}

export interface McpControl {
  state(): McpState;
  setEnabled(enabled: boolean): Promise<McpState>;
  /** Boot: brings the endpoint up when the switch is on. */
  startIfEnabled(): Promise<void>;
  /** Quit: closes the endpoint and cancels what was waiting. */
  shutdown(): Promise<void>;
  approve(id: string, scopes?: Partial<McpScopes>): McpMutationResult;
  reject(id: string): McpMutationResult;
  update(id: string, patch: McpClientPatch): McpMutationResult;
  revoke(id: string): McpMutationResult;
  queryAudit(query: McpAuditPageQuery): McpAuditPage;
  undo(undoToken: string): Promise<SimpleResult>;
  answerConfirm(id: string, answer: McpConfirmAnswer): SimpleResult;
  listConfirms(): McpConfirmRequest[];
}

const UNDO_GONE = 'Ese cambio ya no se puede deshacer';

export function createMcpControl(deps: McpControlDeps): McpControl {
  let error: string | null = null;

  const state = (): McpState => ({
    settings: deps.settings.get(),
    clients: deps.clients.list(),
    connectCommand: deps.connectCommand(),
    listening: deps.endpoint.listening(),
    error,
  });
  const push = (): McpState => {
    const current = state();
    deps.changed(current);
    return current;
  };
  deps.clients.onChange(() => push());

  const start = async (): Promise<void> => {
    try {
      await deps.endpoint.start();
      error = null;
    } catch (failure) {
      error = `No se pudo abrir el servidor MCP: ${errorMessage(failure)}`;
    }
  };
  const stop = async (): Promise<void> => {
    deps.desk.cancelAll();
    await deps.endpoint.stop();
    error = null;
  };
  const mutation = (result: ClientStoreResult): McpMutationResult =>
    result.ok ? { ok: true, state: state() } : result;

  return {
    state,
    setEnabled: async (enabled) => {
      deps.settings.save({ ...deps.settings.get(), enabled });
      if (enabled) await start();
      else await stop();
      return push();
    },
    startIfEnabled: async () => {
      if (!deps.settings.get().enabled) return;
      await start();
      push();
    },
    shutdown: async () => {
      deps.clients.flush();
      await stop();
    },
    approve: (id, scopes) => mutation(deps.clients.approve(id, scopes)),
    reject: (id) => mutation(deps.clients.reject(id)),
    update: (id, patch) => mutation(deps.clients.update(id, patch)),
    revoke: (id) => mutation(deps.clients.revoke(id)),
    queryAudit: (query) =>
      deps.audit.query(query, {
        clients: deps.clients.list(),
        tools: deps.tools,
      }),
    undo: async (undoToken) => {
      const entry = deps.audit.byUndoToken(undoToken);
      if (!entry) return { ok: false, error: UNDO_GONE };
      const result = await deps.restore(entry);
      if (result.ok) deps.audit.update(entry.id, { undoToken: undefined });
      return result;
    },
    answerConfirm: (id, answer) => deps.desk.answer(id, answer),
    listConfirms: () => deps.desk.pending(),
  };
}
