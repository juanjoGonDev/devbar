import type { IpcMainInvokeEvent } from 'electron';
import type { McpControl } from '../mcp/mcp-control.js';
import {
  ipcBooleanField,
  ipcRecord,
  type IpcRegistrar,
} from '../ipc-validators.js';
import {
  ipcMcpAuditQuery,
  ipcMcpClientPatch,
  ipcMcpConfirmAnswer,
  ipcMcpId,
  ipcMcpScopes,
} from '../mcp/validate.js';

/**
 * Settings › MCP from the config window: the switch, approving and revoking
 * assistants, their permissions, the activity log, undo and the answers to
 * the confirmations an assistant waits on. Every payload is narrowed by
 * src/main/mcp/validate.ts before it reaches src/main/mcp.
 */

export interface McpIpcDeps {
  mcp: Pick<
    McpControl,
    | 'state'
    | 'setEnabled'
    | 'approve'
    | 'reject'
    | 'update'
    | 'revoke'
    | 'listAudit'
    | 'undo'
    | 'answerConfirm'
    | 'listConfirms'
  >;
}

const idOf = (payload: unknown): string => ipcMcpId(ipcRecord(payload).id);

export function registerMcpIpc(ipc: IpcRegistrar, deps: McpIpcDeps): void {
  const { mcp } = deps;

  ipc.handle('mcp:getState', () => mcp.state());
  ipc.handle('mcp:setEnabled', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.setEnabled(ipcBooleanField(payload, 'enabled')),
  );
  ipc.handle('mcp:approveClient', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.approve(idOf(payload), ipcMcpScopes(ipcRecord(payload).scopes)),
  );
  ipc.handle('mcp:rejectClient', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.reject(idOf(payload)),
  );
  ipc.handle('mcp:updateClient', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.update(idOf(payload), ipcMcpClientPatch(ipcRecord(payload).patch)),
  );
  ipc.handle('mcp:revokeClient', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.revoke(idOf(payload)),
  );
  ipc.handle('mcp:listAudit', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.listAudit(ipcMcpAuditQuery(payload)),
  );
  ipc.handle('mcp:undo', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.undo(ipcMcpId(ipcRecord(payload).undoToken, 'undoToken')),
  );
  ipc.handle('mcp:answerConfirm', (_e: IpcMainInvokeEvent, payload: unknown) =>
    mcp.answerConfirm(
      idOf(payload),
      ipcMcpConfirmAnswer(ipcRecord(payload).answer),
    ),
  );
  ipc.handle('mcp:listConfirms', () => mcp.listConfirms());
}
