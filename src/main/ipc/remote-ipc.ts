import type { IpcMainInvokeEvent } from 'electron';
import type { RemoteControl } from '../remote/remote-control.js';
import {
  ipcBooleanField,
  ipcNumber,
  ipcRecord,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';

/**
 * «Control remoto» from the config window: the switches, the device list,
 * the desktop half of the pairing handshake (the digits typed there are
 * checked in main), each device's security code and renewing this
 * computer's key. Every payload is narrowed before
 * it reaches src/main/remote; the device-name rule itself lives there, so the
 * phone's pairing form and a rename here are held to the same one.
 */

export interface RemoteIpcDeps {
  remote: Pick<
    RemoteControl,
    | 'status'
    | 'setEnabled'
    | 'setAutoUnlink'
    | 'setNotifyConnections'
    | 'setPort'
    | 'renameDevice'
    | 'unlinkDevice'
    | 'startPairing'
    | 'cancelPairing'
    | 'checkPairCode'
    | 'respondPairing'
    | 'securityCode'
    | 'renewIdentity'
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
    'remote:setNotifyConnections',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.setNotifyConnections(ipcBooleanField(payload, 'enabled')),
  );
  // Only the type is checked here: the range is the user's to get wrong, so
  // setPort answers it with a reason the section can show.
  ipc.handle('remote:setPort', (_e: IpcMainInvokeEvent, payload: unknown) =>
    remote.setPort(ipcNumber(ipcRecord(payload).port, 'port')),
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
    'remote:securityCode',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.securityCode(ipcStringField(payload, 'id')),
  );
  ipc.handle('remote:renewIdentity', () => remote.renewIdentity());
  // The digits are compared in main, in constant time: the window only
  // learns whether they matched.
  ipc.handle(
    'remote:checkPairCode',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.checkPairCode(
        ipcStringField(payload, 'requestId'),
        ipcStringField(payload, 'code'),
      ),
  );
  ipc.handle(
    'remote:respondPairing',
    (_e: IpcMainInvokeEvent, payload: unknown) =>
      remote.respondPairing(
        ipcStringField(payload, 'requestId'),
        ipcBooleanField(payload, 'accept'),
        ipcStringField(payload, 'code'),
      ),
  );
}
