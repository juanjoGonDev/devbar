import type { IpcMainInvokeEvent } from 'electron';
import type { RemoteControl } from '../remote/remote-control.js';
import {
  ipcBooleanField,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';

/**
 * «Control remoto» from the config window: the switches, the device list and
 * the desktop half of the pairing handshake. Every payload is narrowed before
 * it reaches src/main/remote; the device-name rule itself lives there, so the
 * phone's pairing form and a rename here are held to the same one.
 */

export interface RemoteIpcDeps {
  remote: Pick<
    RemoteControl,
    | 'status'
    | 'setEnabled'
    | 'setAutoUnlink'
    | 'renameDevice'
    | 'unlinkDevice'
    | 'startPairing'
    | 'cancelPairing'
    | 'respondPairing'
  >;
}

export function registerRemoteIpc(
  ipc: IpcRegistrar,
  deps: RemoteIpcDeps,
): void {
  const { remote } = deps;

  ipc.handle('remote:getStatus', () => remote.status());
  ipc.handle('remote:setEnabled', (_e: IpcMainInvokeEvent, payload: unknown) =>
    remote.setEnabled(ipcBooleanField(payload, 'enabled')),
  );
  ipc.handle(
    'remote:setAutoUnlink',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.setAutoUnlink(ipcBooleanField(payload, 'enabled')),
  );
  ipc.handle(
    'remote:renameDevice',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.renameDevice(
        ipcStringField(payload, 'id'),
        ipcStringField(payload, 'name'),
      ),
  );
  ipc.handle(
    'remote:unlinkDevice',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.unlinkDevice(ipcStringField(payload, 'id')),
  );
  ipc.handle('remote:startPairing', () => remote.startPairing());
  ipc.handle('remote:cancelPairing', () => {
    remote.cancelPairing();
    return { ok: true };
  });
  ipc.handle(
    'remote:respondPairing',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.respondPairing(
        ipcStringField(payload, 'requestId'),
        ipcBooleanField(payload, 'accept'),
      ),
  );
}
