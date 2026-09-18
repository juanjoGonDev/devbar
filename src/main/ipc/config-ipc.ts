import type { IpcMainInvokeEvent } from 'electron';
import type * as configStoreModule from '../../config-store.js';
import { makeActionId, makeCommandId } from '../../compound-id.js';
import {
  ipcBooleanField,
  ipcGlobalSettingsPatch,
  ipcNumber,
  ipcRecord,
  ipcSilenceLevel,
  ipcString,
  ipcStringArrayField,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';
import type { GroupState } from '../../ipc-contract.js';
import type { ThemePreference } from '../../domain-types.js';

/**
 * Everything the configuration surfaces write: groups, commands, actions, the
 * pipeline's ordered steps and its scripts, silencing, and the global
 * settings. Each handler narrows its payload, mutates the store, and
 * broadcasts — deleting anything that owns a live process stops it FIRST, and
 * a failed stop aborts the deletion rather than leaving an untracked child.
 */

type ConfigStore = Pick<
  typeof configStoreModule,
  | 'listGroups'
  | 'getGroup'
  | 'saveGroup'
  | 'deleteGroup'
  | 'reorderGroups'
  | 'saveCommand'
  | 'deleteCommand'
  | 'reorderCommands'
  | 'saveAction'
  | 'deleteAction'
  | 'reorderActions'
  | 'getPreSteps'
  | 'savePreStep'
  | 'deletePreStep'
  | 'reorderPreSteps'
  | 'assignScriptToStep'
  | 'unassignScriptFromStep'
  | 'savePreScript'
  | 'deletePreScript'
  | 'reorderPreScripts'
  | 'addSilencedPattern'
  | 'removeSilencedPattern'
  | 'setCommandSilence'
  | 'setGroupSilence'
  | 'getGlobalSettings'
  | 'saveGlobalSettings'
>;

export interface ConfigIpcDeps {
  configStore: ConfigStore;
  processManager: {
    stop: (id: string) => Promise<{ ok: boolean; error?: string | undefined }>;
    removeState: (id: string) => void;
    recount: (id: string) => void;
  };
  snapshots: { snapshotGroupStates(): GroupState[] };
  syncRepoWatchers: () => void;
  broadcast: () => void;
  groupErrors: Map<string, string | null>;
  applyAutostart: (enabled: boolean) => void;
  refreshWindowBackgrounds: () => void;
  sendTheme: (theme: ThemePreference) => void;
}

export function registerConfigIpc(
  ipc: IpcRegistrar,
  deps: ConfigIpcDeps,
): void {
  const { configStore, processManager, broadcast } = deps;

  // ── Groups ──────────────────────────────────────────────────────────
  ipc.handle('groups:list', () => configStore.listGroups());
  ipc.handle('groups:states', () => deps.snapshots.snapshotGroupStates());

  ipc.handle('groups:save', (_e: IpcMainInvokeEvent, groupData: unknown) => {
    const saved = configStore.saveGroup(groupData);
    deps.syncRepoWatchers();
    broadcast();
    return saved;
  });

  ipc.handle(
    'groups:delete',
    async (_e: IpcMainInvokeEvent, rawGroupId: unknown) => {
      const groupId = ipcString(rawGroupId, 'groupId');
      const group = configStore.getGroup(groupId);
      if (group) {
        // Stop all running commands in the group. A FAILED stop means a child
        // may still be alive: abort the deletion (state + config) instead of
        // removing the tracking of a live process — the group stays, visible,
        // so the user can retry once it settles.
        for (const cmd of group.commands || []) {
          const pid = makeCommandId(groupId, cmd.id);
          const stopped = await processManager.stop(pid);
          if (!stopped.ok)
            return {
              ok: false,
              error:
                stopped.error ?? `No se pudo parar «${cmd.name}» para borrarlo`,
            };
          processManager.removeState(pid);
        }
        for (const act of group.actions || []) {
          const pid = makeActionId(groupId, act.id);
          const stopped = await processManager.stop(pid);
          if (!stopped.ok)
            return {
              ok: false,
              error:
                stopped.error ?? `No se pudo parar «${act.name}» para borrarlo`,
            };
          processManager.removeState(pid);
        }
      }
      configStore.deleteGroup(groupId);
      deps.groupErrors.delete(groupId);
      deps.syncRepoWatchers();
      broadcast();
      return { ok: true };
    },
  );

  ipc.handle('groups:reorder', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const groupIds =
      Array.isArray(payload) &&
      payload.every((item: unknown) => typeof item === 'string')
        ? payload
        : null;
    if (!groupIds) throw new TypeError('Invalid IPC groupIds');
    configStore.reorderGroups(groupIds);
    broadcast();
    return { ok: true };
  });

  // ── Commands ─────────────────────────────────────────────────────────
  ipc.handle('commands:save', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const saved = configStore.saveCommand(
      ipcString(raw.groupId, 'groupId'),
      raw.commandData,
    );
    broadcast();
    return saved;
  });

  ipc.handle(
    'commands:delete',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const pid = makeCommandId(groupId, commandId);
      // Same contract as groups:delete — a failed stop aborts the deletion so
      // a live process is never left untracked.
      const stopped = await processManager.stop(pid);
      if (!stopped.ok)
        return {
          ok: false,
          error: stopped.error ?? 'No se pudo parar el comando para borrarlo',
        };
      processManager.removeState(pid);
      configStore.deleteCommand(groupId, commandId);
      broadcast();
      return { ok: true };
    },
  );

  ipc.handle('commands:reorder', (_e: IpcMainInvokeEvent, payload: unknown) => {
    configStore.reorderCommands(
      ipcStringField(payload, 'groupId'),
      ipcStringArrayField(payload, 'commandIds'),
    );
    broadcast();
    return { ok: true };
  });

  ipc.handle(
    'commands:setAutoStart',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const groupId = ipcStringField(payload, 'groupId');
      const commandId = ipcStringField(payload, 'commandId');
      const enabled = ipcBooleanField(payload, 'enabled');
      const group = configStore.getGroup(groupId);
      if (!group) return { ok: false, error: 'group not found' };
      const cmd = (group.commands || []).find((c) => c.id === commandId);
      if (!cmd) return { ok: false, error: 'command not found' };

      let nextCommands = group.commands.map((c) =>
        c.id === commandId ? { ...c, autoStart: !!enabled } : c,
      );
      // In single mode, enabling one command's autoStart clears all others
      // (radio semantics). Disabling does nothing extra.
      if (enabled && group.mode === 'single') {
        nextCommands = nextCommands.map((c) =>
          c.id === commandId ? c : { ...c, autoStart: false },
        );
      }
      configStore.saveGroup({ ...group, commands: nextCommands });
      broadcast();
      return { ok: true };
    },
  );

  // ── Actions ──────────────────────────────────────────────────────────
  ipc.handle('actions:save', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const saved = configStore.saveAction(
      ipcString(raw.groupId, 'groupId'),
      raw.actionData,
    );
    broadcast();
    return saved;
  });

  ipc.handle('actions:delete', (_e: IpcMainInvokeEvent, payload: unknown) => {
    configStore.deleteAction(
      ipcStringField(payload, 'groupId'),
      ipcStringField(payload, 'actionId'),
    );
    broadcast();
    return { ok: true };
  });

  ipc.handle('actions:reorder', (_e: IpcMainInvokeEvent, payload: unknown) => {
    configStore.reorderActions(
      ipcStringField(payload, 'groupId'),
      ipcStringArrayField(payload, 'actionIds'),
    );
    broadcast();
    return { ok: true };
  });

  // ── Pipeline CONFIG ───────────────────────────────────────────────────
  // Mirrors the groups:list/groups:save split; runtime state is broadcast
  // separately on pipeline:update.
  ipc.handle('pipeline:list', () => configStore.getPreSteps());

  ipc.handle('preSteps:save', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const result = configStore.savePreStep(ipcRecord(payload).data);
    broadcast();
    return result;
  });
  ipc.handle('preSteps:delete', (_e: IpcMainInvokeEvent, payload: unknown) => {
    configStore.deletePreStep(ipcStringField(payload, 'stepId'));
    broadcast();
    return { ok: true };
  });
  ipc.handle('preSteps:reorder', (_e: IpcMainInvokeEvent, payload: unknown) => {
    configStore.reorderPreSteps(ipcStringArrayField(payload, 'orderedIds'));
    broadcast();
    return { ok: true };
  });
  ipc.handle(
    'preSteps:assignScript',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const result = configStore.assignScriptToStep(
        ipcString(raw.stepId, 'stepId'),
        ipcString(raw.groupId, 'groupId'),
        ipcString(raw.scriptId, 'scriptId'),
        raw.position === undefined
          ? undefined
          : ipcNumber(raw.position, 'position'),
      );
      broadcast();
      return result;
    },
  );
  ipc.handle(
    'preSteps:unassignScript',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const result = configStore.unassignScriptFromStep(
        ipcString(raw.stepId, 'stepId'),
        ipcString(raw.groupId, 'groupId'),
        ipcString(raw.scriptId, 'scriptId'),
      );
      broadcast();
      return result;
    },
  );
  ipc.handle('preScripts:save', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const result = configStore.savePreScript(
      ipcString(raw.groupId, 'groupId'),
      raw.data,
    );
    broadcast();
    return result;
  });
  ipc.handle(
    'preScripts:delete',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      configStore.deletePreScript(
        ipcStringField(payload, 'groupId'),
        ipcStringField(payload, 'scriptId'),
      );
      broadcast();
      return { ok: true };
    },
  );
  ipc.handle(
    'preScripts:reorder',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      configStore.reorderPreScripts(
        ipcStringField(payload, 'groupId'),
        ipcStringArrayField(payload, 'orderedIds'),
      );
      broadcast();
      return { ok: true };
    },
  );

  // ── Silence ──────────────────────────────────────────────────────────
  const recountAndBroadcast = (groupId: string, commandId: string): void => {
    processManager.recount(makeCommandId(groupId, commandId));
    broadcast();
  };

  ipc.handle('silence:add', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const groupId = ipcString(raw.groupId, 'groupId');
    const commandId = ipcString(raw.commandId, 'commandId');
    const cmd = configStore.addSilencedPattern(
      groupId,
      commandId,
      ipcSilenceLevel(raw.level),
      ipcString(raw.pattern, 'pattern'),
    );
    if (cmd) recountAndBroadcast(groupId, commandId);
    return { ok: !!cmd, command: cmd };
  });

  ipc.handle('silence:remove', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const groupId = ipcString(raw.groupId, 'groupId');
    const commandId = ipcString(raw.commandId, 'commandId');
    const cmd = configStore.removeSilencedPattern(
      groupId,
      commandId,
      ipcSilenceLevel(raw.level),
      ipcString(raw.pattern, 'pattern'),
    );
    if (cmd) recountAndBroadcast(groupId, commandId);
    return { ok: !!cmd, command: cmd };
  });

  ipc.handle(
    'silence:setCommand',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const raw = ipcRecord(payload);
      const cmd = configStore.setCommandSilence(
        ipcString(raw.groupId, 'groupId'),
        ipcString(raw.commandId, 'commandId'),
        ipcSilenceLevel(raw.level),
        ipcBooleanField(payload, 'enabled'),
      );
      if (cmd) broadcast();
      return { ok: !!cmd, command: cmd };
    },
  );

  ipc.handle('silence:setGroup', (_e: IpcMainInvokeEvent, payload: unknown) => {
    const raw = ipcRecord(payload);
    const grp = configStore.setGroupSilence(
      ipcString(raw.groupId, 'groupId'),
      ipcSilenceLevel(raw.level),
      ipcBooleanField(payload, 'enabled'),
    );
    if (grp) broadcast();
    return { ok: !!grp, group: grp };
  });

  // ── Settings ──────────────────────────────────────────────────────────
  ipc.handle('settings:get', () => configStore.getGlobalSettings());
  ipc.handle('settings:save', (_e: IpcMainInvokeEvent, rawPatch: unknown) => {
    const next = configStore.saveGlobalSettings(
      ipcGlobalSettingsPatch(rawPatch),
    );
    deps.applyAutostart(next.autostart);
    if (next.theme !== undefined) {
      deps.refreshWindowBackgrounds();
      // Push the resolved preference on its OWN channel. Renderers used to
      // re-read the settings off the `groups:update` broadcast, which fires
      // once per non-silenced warn/error line, in every open window — a
      // synchronous full config read + schema validation per line on the main
      // thread.
      deps.sendTheme(next.theme);
    }
    broadcast();
    return next;
  });
}
