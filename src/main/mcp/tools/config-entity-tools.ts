import { z } from 'zod';
import type { Group } from '../../../domain-types.js';
import {
  normalizeAction,
  normalizeCommand,
  normalizeGroup,
  normalizePreScript,
} from '../../../groups-model.js';
import {
  ACTION_FIELDS,
  COMMAND_FIELDS,
  diffEntity,
  GROUP_FIELDS,
  PRESCRIPT_FIELDS,
} from '../config-diff.js';
import {
  applyChange,
  given,
  handlerError,
  iconFields,
} from './config-apply.js';
import {
  ACTION_INPUT,
  COMMAND_INPUT,
  GROUP_INPUT,
  PRESCRIPT_INPUT,
  reason,
} from './config-schemas.js';
import {
  defineTool,
  findGroup,
  label,
  ToolError,
  type ToolContext,
  type ToolDef,
} from './tool-kit.js';

/**
 * The `config` scope for groups and what lives in them — commands, actions
 * and pre-scripts: create, update (only the fields given change) and delete,
 * every field Settings edits included (icon or uploaded image, colour,
 * folder, env, schedule, link…). Each goes through `applyChange`: diff,
 * confirmation in DevBar, backup, then the app's own handler.
 */

const OWN_PARAMS = ['group', 'target', 'reason', 'image', 'folder'];

const DESTRUCTIVE = { destructiveHint: true, openWorldHint: false } as const;
const WRITES = { destructiveHint: false, openWorldHint: false } as const;

/** A schedule given without its rules or interval keeps the ones it had. */
function withSchedule(
  fields: Record<string, unknown>,
  before: { schedule: { rules: unknown; interval: unknown } } | null,
): Record<string, unknown> {
  const schedule = fields.schedule as Record<string, unknown> | undefined;
  if (!schedule) return fields;
  return {
    ...fields,
    schedule: {
      rules: before?.schedule.rules ?? [],
      interval: before?.schedule.interval ?? null,
      ...schedule,
    },
  };
}

// ── Groups ────────────────────────────────────────────────────────────

function groupRaw(
  args: Record<string, unknown>,
  icon: { icon?: string },
): Record<string, unknown> {
  const fields = given(args, OWN_PARAMS);
  if (args.folder !== undefined) fields.path = args.folder;
  return { ...fields, ...icon };
}

const groupTools: ToolDef[] = [
  defineTool({
    name: 'create_group',
    scope: 'config',
    title: 'Create a group',
    description:
      'Create a group: a project folder that holds commands, actions and pre-scripts.',
    input: {
      ...GROUP_INPUT,
      name: z.string().min(1).max(200),
      folder: z.string().min(1).max(4096),
      reason,
    },
    annotations: WRITES,
    run: async (args, ctx) => {
      if (ctx.client.groups !== 'all')
        throw new ToolError(
          'Solo un asistente con acceso a todos los grupos puede crear grupos',
        );
      const { storeIcon, ...icon } = await iconFields(ctx, args);
      const after = normalizeGroup({
        icon: 'folder',
        ...groupRaw(args, icon),
        commands: [],
        actions: [],
        preScripts: [],
      });
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere crear un grupo`,
        subtitle: `Grupo ${after.name}`,
        target: after.name,
        change: diffEntity(GROUP_FIELDS, null, after),
        reason: args.reason,
        slice: { kind: 'group', groupId: after.id },
        write: async () => {
          await storeIcon();
          return handlerError(
            await ctx.changes.port.invoke('groups:save', after),
            'No se pudo crear el grupo',
          );
        },
        data: () => ({ id: after.id }),
      });
    },
  }),
  defineTool({
    name: 'update_group',
    scope: 'config',
    title: 'Update a group',
    description:
      'Change a group: only the fields given change (env replaces the whole list).',
    input: { group: z.string(), ...GROUP_INPUT, reason },
    annotations: WRITES,
    run: async (args, ctx) => {
      const before = findGroup(ctx, args.group);
      const { storeIcon, ...icon } = await iconFields(ctx, args);
      const after = normalizeGroup({ ...before, ...groupRaw(args, icon) });
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere cambiar un grupo`,
        subtitle: `Grupo ${before.name}`,
        target: before.name,
        change: diffEntity(GROUP_FIELDS, normalizeGroup(before), after),
        reason: args.reason,
        slice: { kind: 'group', groupId: before.id },
        write: async () => {
          await storeIcon();
          return handlerError(
            await ctx.changes.port.invoke('groups:save', after),
            'No se pudo guardar el grupo',
          );
        },
      });
    },
  }),
  defineTool({
    name: 'delete_group',
    scope: 'config',
    title: 'Delete a group',
    description:
      'Delete a group with everything in it; its running commands are stopped first. Can be undone (undo_last_change).',
    input: { group: z.string(), reason },
    annotations: DESTRUCTIVE,
    run: async (args, ctx) => {
      const before = findGroup(ctx, args.group);
      return applyChange(ctx, {
        title: `${ctx.client.name} quiere borrar un grupo`,
        subtitle: `Grupo ${before.name}`,
        target: before.name,
        change: diffEntity(GROUP_FIELDS, before, null),
        reason: args.reason,
        slice: { kind: 'group', groupId: before.id },
        write: async () =>
          handlerError(
            await ctx.changes.port.invoke('groups:delete', before.id),
            'No se pudo borrar el grupo',
          ),
      });
    },
  }),
];

// ── Commands, actions and pre-scripts ─────────────────────────────────

interface Kind {
  key: 'command' | 'action' | 'prescript';
  /** «comando», with its article for titles. */
  noun: string;
  article: 'un' | 'una';
  input: Record<string, z.ZodType>;
  fields: Parameters<typeof diffEntity>[0];
  normalize(raw: unknown): { id: string; name: string };
  list(group: Group): { id: string; name: string }[];
  save: string;
  savePayload(groupId: string, entity: unknown): unknown;
  remove: string;
  removePayload(groupId: string, id: string): unknown;
  description: string;
}

const KINDS: readonly Kind[] = [
  {
    key: 'command',
    noun: 'comando',
    article: 'un',
    input: COMMAND_INPUT,
    fields: COMMAND_FIELDS,
    normalize: normalizeCommand,
    list: (group) => group.commands,
    save: 'commands:save',
    savePayload: (groupId, commandData) => ({ groupId, commandData }),
    remove: 'commands:delete',
    removePayload: (groupId, commandId) => ({ groupId, commandId }),
    description: 'a command (a long-running service such as a dev server)',
  },
  {
    key: 'action',
    noun: 'acción',
    article: 'una',
    input: ACTION_INPUT,
    fields: ACTION_FIELDS,
    normalize: normalizeAction,
    list: (group) => group.actions,
    save: 'actions:save',
    savePayload: (groupId, actionData) => ({ groupId, actionData }),
    remove: 'actions:delete',
    removePayload: (groupId, actionId) => ({ groupId, actionId }),
    description: 'an action (a one-off task such as a build)',
  },
  {
    key: 'prescript',
    noun: 'pre-script',
    article: 'un',
    input: PRESCRIPT_INPUT,
    fields: PRESCRIPT_FIELDS,
    normalize: normalizePreScript,
    list: (group) => group.preScripts,
    save: 'preScripts:save',
    savePayload: (groupId, data) => ({ groupId, data }),
    remove: 'preScripts:delete',
    removePayload: (groupId, scriptId) => ({ groupId, scriptId }),
    description: 'a pre-script (a step that workflows run)',
  },
];

function find(
  kind: Kind,
  group: Group,
  ref: string,
): { id: string; name: string } {
  const items = kind.list(group);
  const item =
    items.find((candidate) => candidate.id === ref) ??
    items.find(
      (candidate) => candidate.name.toLowerCase() === ref.trim().toLowerCase(),
    );
  if (!item)
    throw new ToolError(
      `El grupo «${group.name}» no tiene ${kind.article === 'un' ? 'el' : 'la'} ${kind.noun} «${ref}»`,
    );
  return item;
}

async function upsert(
  kind: Kind,
  ctx: ToolContext,
  args: Record<string, unknown>,
  ref: string | null,
): ReturnType<typeof applyChange> {
  const group = findGroup(ctx, String(args.group));
  // Normalized like what is stored, so the diff shows only real changes.
  const before = ref === null ? null : kind.normalize(find(kind, group, ref));
  const { storeIcon, ...icon } = await iconFields(ctx, args);
  const fields = withSchedule(
    { ...given(args, OWN_PARAMS), ...icon },
    before as { schedule: { rules: unknown; interval: unknown } } | null,
  );
  const after = kind.normalize({ ...(before ?? {}), ...fields });
  const verb = before ? 'cambiar' : 'añadir';
  return applyChange(ctx, {
    title: `${ctx.client.name} quiere ${verb} ${kind.article} ${kind.noun}`,
    subtitle: `Grupo ${group.name} · ${kind.noun} ${after.name}`,
    target: label(group.name, after.name),
    change: diffEntity(kind.fields, before, after),
    reason: args.reason as string | undefined,
    slice: { kind: kind.key, groupId: group.id, id: after.id },
    write: async () => {
      await storeIcon();
      return handlerError(
        await ctx.changes.port.invoke(
          kind.save,
          kind.savePayload(group.id, after),
        ),
        `No se pudo guardar ${kind.article === 'un' ? 'el' : 'la'} ${kind.noun}`,
      );
    },
    data: () => ({ id: after.id }),
  });
}

function kindTools(kind: Kind): ToolDef[] {
  const english = kind.key === 'prescript' ? 'pre-script' : kind.key;
  return [
    defineTool({
      name: `create_${kind.key}`,
      scope: 'config',
      title: `Create ${kind.article === 'un' ? 'a' : 'an'} ${english}`,
      description: `Add ${kind.description} to a group.`,
      input: {
        group: z.string(),
        ...kind.input,
        name: z.string().min(1).max(200),
        command: z.string().min(1).max(10_000).describe('The command line.'),
        reason,
      },
      annotations: WRITES,
      run: (args, ctx) => upsert(kind, ctx, args, null),
    }),
    defineTool({
      name: `update_${kind.key}`,
      scope: 'config',
      title: `Update ${kind.article === 'un' ? 'a' : 'an'} ${english}`,
      description: `Change ${kind.description}: only the fields given change (env and args replace the whole list).`,
      input: {
        group: z.string(),
        target: z.string().describe(`The ${english} id or name.`),
        ...kind.input,
        reason,
      },
      annotations: WRITES,
      run: (args, ctx) => upsert(kind, ctx, args, args.target),
    }),
    defineTool({
      name: `delete_${kind.key}`,
      scope: 'config',
      title: `Delete ${kind.article === 'un' ? 'a' : 'an'} ${english}`,
      description: `Delete ${kind.description}; it is stopped first if running. Can be undone (undo_last_change).`,
      input: {
        group: z.string(),
        target: z.string().describe(`The ${english} id or name.`),
        reason,
      },
      annotations: DESTRUCTIVE,
      run: async (args, ctx) => {
        const group = findGroup(ctx, args.group);
        const item = find(kind, group, args.target);
        const before =
          kind.list(group).find((candidate) => candidate.id === item.id) ??
          null;
        return applyChange(ctx, {
          title: `${ctx.client.name} quiere borrar ${kind.article} ${kind.noun}`,
          subtitle: `Grupo ${group.name} · ${kind.noun} ${item.name}`,
          target: label(group.name, item.name),
          change: diffEntity(kind.fields, before, null),
          reason: args.reason,
          slice: { kind: kind.key, groupId: group.id, id: item.id },
          write: async () =>
            handlerError(
              await ctx.changes.port.invoke(
                kind.remove,
                kind.removePayload(group.id, item.id),
              ),
              `No se pudo borrar ${kind.article === 'un' ? 'el' : 'la'} ${kind.noun}`,
            ),
        });
      },
    }),
  ];
}

export const ENTITY_CONFIG_TOOLS: readonly ToolDef[] = [
  ...groupTools,
  ...KINDS.flatMap(kindTools),
];
