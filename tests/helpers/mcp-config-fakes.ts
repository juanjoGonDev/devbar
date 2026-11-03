/**
 * The app's config handlers, faked over a fake runtime's groups and
 * workflows: each `invoke` does to them what the real handler does to the
 * store, so the MCP config tools can be exercised end to end.
 */
import type { Group, Workflow } from '../../src/domain-types.js';
import { normalizeGroup } from '../../src/groups-model.js';
import type {
  ConfigSnapshot,
  McpConfigPort,
} from '../../src/main/mcp/config-changes.js';
import type { FakeRuntime } from './mcp-fakes.js';

export interface FakeConfigPort extends McpConfigPort {
  invocations: { channel: string; payload: unknown }[];
  backups: Map<string, unknown>;
  /** Makes the next handler call answer this instead. */
  failNext: unknown;
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

/**
 * The app's config handlers over the fake runtime's groups and workflows:
 * each `invoke` does what the real handler would to the store.
 */
export function fakeConfigPort(runtime: FakeRuntime): FakeConfigPort {
  let tokens = 0;
  const group = (id: unknown) =>
    runtime.groups.find((candidate) => candidate.id === id);
  type Raw = Record<string, unknown>;
  const handlers: Record<string, (payload: Raw) => unknown> = {
    'groups:save': (payload) => {
      upsert(runtime.groups, structuredClone(payload) as unknown as Group);
      return payload;
    },
    'groups:delete': (payload) => {
      runtime.groups = runtime.groups.filter(
        (g) => g.id !== (payload as unknown),
      );
      return { ok: true };
    },
    'commands:save': ({ groupId, commandData }) => {
      const target = group(groupId);
      if (!target) return null;
      upsert(
        target.commands,
        structuredClone(commandData) as Group['commands'][number],
      );
      return commandData;
    },
    'commands:delete': ({ groupId, commandId }) => {
      const target = group(groupId);
      if (target)
        target.commands = target.commands.filter((c) => c.id !== commandId);
      return { ok: true };
    },
    'actions:save': ({ groupId, actionData }) => {
      const target = group(groupId);
      if (!target) return null;
      upsert(
        target.actions,
        structuredClone(actionData) as Group['actions'][number],
      );
      return actionData;
    },
    'actions:delete': ({ groupId, actionId }) => {
      const target = group(groupId);
      if (target)
        target.actions = target.actions.filter((a) => a.id !== actionId);
      return { ok: true };
    },
    'preScripts:save': ({ groupId, data }) => {
      const target = group(groupId);
      if (!target) return null;
      upsert(
        target.preScripts,
        structuredClone(data) as Group['preScripts'][number],
      );
      return data;
    },
    'preScripts:delete': ({ groupId, scriptId }) => {
      const target = group(groupId);
      if (target)
        target.preScripts = target.preScripts.filter((p) => p.id !== scriptId);
      return { ok: true };
    },
    'workflows:save': ({ workflow }) => {
      upsert(runtime.workflows, structuredClone(workflow) as Workflow);
      return workflow;
    },
    'workflows:delete': ({ workflowId }) => {
      runtime.workflows = runtime.workflows.filter((w) => w.id !== workflowId);
      return { ok: true };
    },
    'customIcons:addRasterized': ({ name }) => ({
      ok: true,
      icon: { id: 'abc123def456', name },
    }),
  };
  const snapshot = (): ConfigSnapshot => ({
    backedUpAt: 'now',
    version: 4,
    groups: structuredClone(runtime.groups),
    workflows: structuredClone(runtime.workflows),
    globalSettings: {} as ConfigSnapshot['globalSettings'],
    customIcons: [],
  });
  const port: FakeConfigPort = {
    invocations: [],
    backups: new Map(),
    failNext: undefined,
    invoke: (channel, payload) => {
      port.invocations.push({ channel, payload });
      if (port.failNext !== undefined) {
        const answer = port.failNext;
        port.failNext = undefined;
        return Promise.resolve(answer);
      }
      const handler = handlers[channel];
      if (!handler) return Promise.reject(new Error(`no handler ${channel}`));
      return Promise.resolve(handler(payload as Raw));
    },
    exportConfig: () => ({ ...snapshot(), exportedAt: 'now' }),
    importConfig: (value) => {
      const incoming = value as { groups?: Group[]; workflows?: Workflow[] };
      if (!Array.isArray(incoming.groups))
        return Promise.resolve({
          ok: false,
          error: 'groups debe ser un array',
        });
      runtime.groups = incoming.groups.map(normalizeGroup);
      runtime.workflows = structuredClone(incoming.workflows ?? []);
      return Promise.resolve({ ok: true, backupPath: '/backup.json' });
    },
    snapshot,
    writeBackup: (token, record) => {
      port.backups.set(token, structuredClone(record));
    },
    readBackup: (token) =>
      (structuredClone(port.backups.get(token)) as ReturnType<
        McpConfigPort['readBackup']
      >) ?? null,
    newToken: () => `undo-token-${++tokens}`,
    decodeImage: (bytes) => fakeImage(bytes.length ? 128 : 0),
    rasterizeSvg: () => Promise.resolve(Buffer.from('rasterized-svg')),
  };
  return port;
}

function fakeImage(side: number): ReturnType<McpConfigPort['decodeImage']> {
  return {
    isEmpty: () => side === 0,
    getSize: () => ({ width: side, height: side }),
    resize: ({ width }) => fakeImage(width),
    toPNG: () => Buffer.from(`png-${side}`),
  };
}
