import type { IpcMainInvokeEvent } from 'electron';
import { makeCommandId } from '../../compound-id.js';
import type { DetectedPort, Group } from '../../domain-types.js';
import { isLocalHttpUrl, resolveOpenUrl } from '../../ports/port-links.js';
import {
  ipcNumber,
  ipcRecord,
  ipcString,
  type IpcRegistrar,
} from '../ipc-validators.js';

/**
 * «Abrir» a command's page: resolves the URL from its link and its detected
 * ports, and opens it only when it is http(s) on this machine or the LAN —
 * a custom link pointing anywhere else is refused, never opened.
 */
export interface PortsIpcDeps {
  configStore: { getGroup: (id: string) => Group | null };
  portsOf: (processId: string) => DetectedPort[];
  openExternal: (url: string) => void;
  machineHostname: () => string | null;
}

type OpenResult = { ok: true } | { ok: false; error: string };

export function openCommandPort(
  deps: PortsIpcDeps,
  groupId: string,
  commandId: string,
  port?: number,
): OpenResult {
  const command = deps.configStore
    .getGroup(groupId)
    ?.commands.find((candidate) => candidate.id === commandId);
  if (!command) return { ok: false, error: 'Comando no encontrado' };
  const target = resolveOpenUrl(
    command.link,
    deps.portsOf(makeCommandId(groupId, commandId)),
    port,
  );
  if (!target.ok) return target;
  if (!isLocalHttpUrl(target.url, deps.machineHostname()))
    return {
      ok: false,
      error: 'Solo se abren direcciones locales o de la red',
    };
  deps.openExternal(target.url);
  return { ok: true };
}

export function registerPortsIpc(ipc: IpcRegistrar, deps: PortsIpcDeps): void {
  ipc.handle('ports:open', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const port =
      raw.port === undefined || raw.port === null
        ? undefined
        : ipcNumber(raw.port, 'port');
    return openCommandPort(
      deps,
      ipcString(raw.groupId, 'groupId'),
      ipcString(raw.commandId, 'commandId'),
      port,
    );
  });
}
