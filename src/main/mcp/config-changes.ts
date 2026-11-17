import type {
  CustomIcon,
  GlobalSettings,
  Group,
  Workflow,
} from '../../domain-types.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import type { DecodedImage } from '../custom-icon-upload.js';
import type { ConfigImportResult } from '../config-import.js';
import { errorMessage } from '../ipc-validators.js';

/**
 * How an assistant's configuration change is applied and undone.
 *
 * Every write goes through the very IPC handlers Settings calls (`invoke`
 * reaches them in process), so it is validated, persisted and broadcast
 * exactly like a change made by hand — deleting a command still stops it
 * first. Before each one, the whole configuration is backed up (the same
 * snapshot as the pre-import backup) together with the slice it touches:
 * undoing puts back only that slice from the backup — that group, command,
 * action, pre-script or workflow, or everything for an import — so later,
 * unrelated edits survive the undo.
 */

export interface ConfigSnapshot {
  backedUpAt: string;
  version: number;
  groups: Group[];
  workflows: Workflow[];
  globalSettings: GlobalSettings;
  customIcons: CustomIcon[];
}

export type UndoSlice =
  | { kind: 'group'; groupId: string }
  | {
      kind: 'command' | 'action' | 'prescript';
      groupId: string;
      id: string;
    }
  | { kind: 'workflow'; id: string }
  | { kind: 'all' };

interface BackupRecord {
  slice: UndoSlice;
  snapshot: ConfigSnapshot;
}

/** What the MCP config tools reach the app through. */
export interface McpConfigPort {
  /** Runs one of the app's own IPC handlers (`groups:save`…). */
  invoke(channel: string, payload: unknown): Promise<unknown>;
  exportConfig(): unknown;
  /** Validates like a file import, then replaces everything. */
  importConfig(value: unknown): Promise<ConfigImportResult>;
  snapshot(): ConfigSnapshot;
  writeBackup(token: string, record: BackupRecord): void;
  readBackup(token: string): BackupRecord | null;
  newToken(): string;
  decodeImage(bytes: Buffer): DecodedImage;
  /** An SVG drawn to a PNG (no scripts, no network), or null. */
  rasterizeSvg(svg: string, size: number): Promise<Buffer | null>;
}

export interface ConfigChanges {
  port: McpConfigPort;
  /** Backs everything up for `slice`; answers the undo token. */
  backup(slice: UndoSlice): string;
  restore(token: string): Promise<SimpleResult>;
}

const failed = (error: string): SimpleResult => ({ ok: false, error });

/** A save handler answers the entity, or null when its group is gone. */
function saved(value: unknown, what: string): SimpleResult {
  if (value === null || value === undefined)
    return failed(`No se pudo restaurar ${what}: su grupo ya no existe`);
  const outcome = value as { ok?: unknown; error?: unknown };
  if (outcome.ok === false)
    return failed(typeof outcome.error === 'string' ? outcome.error : what);
  return { ok: true };
}

export function createConfigChanges(port: McpConfigPort): ConfigChanges {
  /** The workflows of the backup that run anything `matches`. */
  const restoreWorkflowsUsing = async (
    snapshot: ConfigSnapshot,
    matches: (ref: { groupId: string; scriptId: string }) => boolean,
  ): Promise<void> => {
    for (const workflow of snapshot.workflows)
      if (workflow.graph.blocks.some((block) => block.scripts.some(matches)))
        await port.invoke('workflows:save', { workflow });
  };

  const restoreSlice = async (record: BackupRecord): Promise<SimpleResult> => {
    const { slice, snapshot } = record;
    if (slice.kind === 'all') {
      const result = await port.importConfig(snapshot);
      return result.ok ? { ok: true } : failed(result.error);
    }
    if (slice.kind === 'workflow') {
      const before = snapshot.workflows.find((w) => w.id === slice.id);
      if (before) await port.invoke('workflows:save', { workflow: before });
      else await port.invoke('workflows:delete', { workflowId: slice.id });
      return { ok: true };
    }
    const group = snapshot.groups.find((g) => g.id === slice.groupId);
    if (slice.kind === 'group') {
      if (!group)
        return saved(
          await port.invoke('groups:delete', slice.groupId),
          'el grupo',
        );
      const result = saved(await port.invoke('groups:save', group), 'el grupo');
      if (result.ok)
        await restoreWorkflowsUsing(
          snapshot,
          (ref) => ref.groupId === group.id,
        );
      return result;
    }
    const groupId = slice.groupId;
    if (slice.kind === 'command') {
      const before = group?.commands.find((c) => c.id === slice.id);
      return before
        ? saved(
            await port.invoke('commands:save', {
              groupId,
              commandData: before,
            }),
            'el comando',
          )
        : saved(
            await port.invoke('commands:delete', {
              groupId,
              commandId: slice.id,
            }),
            'el comando',
          );
    }
    if (slice.kind === 'action') {
      const before = group?.actions.find((a) => a.id === slice.id);
      return before
        ? saved(
            await port.invoke('actions:save', { groupId, actionData: before }),
            'la acción',
          )
        : saved(
            await port.invoke('actions:delete', {
              groupId,
              actionId: slice.id,
            }),
            'la acción',
          );
    }
    const before = group?.preScripts.find((s) => s.id === slice.id);
    if (!before)
      return saved(
        await port.invoke('preScripts:delete', { groupId, scriptId: slice.id }),
        'el pre-script',
      );
    const result = saved(
      await port.invoke('preScripts:save', { groupId, data: before }),
      'el pre-script',
    );
    if (result.ok)
      await restoreWorkflowsUsing(
        snapshot,
        (ref) => ref.groupId === groupId && ref.scriptId === slice.id,
      );
    return result;
  };

  return {
    port,
    backup: (slice) => {
      const token = port.newToken();
      port.writeBackup(token, { slice, snapshot: port.snapshot() });
      return token;
    },
    restore: async (token) => {
      const record = port.readBackup(token);
      if (!record) return failed('La copia de ese cambio ya no existe');
      try {
        return await restoreSlice(record);
      } catch (error) {
        return failed(errorMessage(error));
      }
    },
  };
}
