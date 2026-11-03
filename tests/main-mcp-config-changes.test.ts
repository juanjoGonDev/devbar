import { describe, expect, it } from 'vitest';
import {
  createConfigChanges,
  type UndoSlice,
} from '../src/main/mcp/config-changes.js';
import {
  makeAction,
  makeCommand,
  makePreScript,
} from './helpers/main-fakes.js';
import { fakeConfigPort, fakeRuntime } from './helpers/mcp-fakes.js';

function harness() {
  const runtime = fakeRuntime();
  const back = runtime.groups[0];
  if (back) {
    back.actions = [makeAction({ id: 'build', name: 'Build' })];
    back.preScripts = [makePreScript({ id: 'vpn', name: 'VPN' })];
  }
  runtime.workflows = [
    {
      id: 'boot',
      name: 'Arranque',
      enabled: true,
      hidden: false,
      trigger: { kind: 'manual', confirm: false },
      graph: {
        blocks: [
          {
            id: 'b1',
            scripts: [{ groupId: 'back', scriptId: 'vpn' }],
            x: 0,
            y: 0,
            requireAll: true,
          },
        ],
        edges: [{ from: 'trigger', to: 'b1' }],
      },
    },
  ];
  const port = fakeConfigPort(runtime);
  return { runtime, port, changes: createConfigChanges(port) };
}

const groupNamed = (h: ReturnType<typeof harness>, id: string) =>
  h.runtime.groups.find((g) => g.id === id);

describe('src/main/mcp/config-changes.ts', () => {
  it('backs the whole config up with the slice and answers a token', () => {
    const h = harness();
    const slice: UndoSlice = { kind: 'group', groupId: 'back' };

    const token = h.changes.backup(slice);

    expect(token).toBe('undo-token-1');
    expect(h.port.backups.get(token)).toMatchObject({
      slice,
      snapshot: { groups: [{ id: 'back' }, { id: 'front' }] },
    });
  });

  it('restores a deleted group and the workflows that ran its scripts', async () => {
    const h = harness();
    const token = h.changes.backup({ kind: 'group', groupId: 'back' });
    h.runtime.groups = h.runtime.groups.filter((g) => g.id !== 'back');
    h.runtime.workflows = [];

    expect(await h.changes.restore(token)).toEqual({ ok: true });

    expect(groupNamed(h, 'back')?.name).toBe('Back');
    expect(h.runtime.workflows.map((w) => w.id)).toEqual(['boot']);
  });

  it('removes a group that the change created', async () => {
    const h = harness();
    const token = h.changes.backup({ kind: 'group', groupId: 'docs' });
    h.runtime.groups.push({
      ...structuredClone(h.runtime.groups[0]),
      id: 'docs',
    });

    await h.changes.restore(token);

    expect(groupNamed(h, 'docs')).toBeUndefined();
  });

  it('puts back only the command it touched, keeping later edits elsewhere', async () => {
    const h = harness();
    const token = h.changes.backup({
      kind: 'command',
      groupId: 'back',
      id: 'normal',
    });
    const back = groupNamed(h, 'back');
    if (back) {
      back.commands[0] = makeCommand({
        id: 'normal',
        name: 'Normal',
        command: 'changed',
      });
      back.name = 'Back (renamed later)';
    }

    await h.changes.restore(token);

    expect(groupNamed(h, 'back')?.commands[0]?.command).toBe('pnpm start:dev');
    expect(groupNamed(h, 'back')?.name).toBe('Back (renamed later)');
  });

  it.each<[UndoSlice['kind'], string, string]>([
    ['command', 'commands:delete', 'brand-new'],
    ['action', 'actions:delete', 'brand-new'],
    ['prescript', 'preScripts:delete', 'brand-new'],
  ])('deletes a %s the change created', async (kind, channel, id) => {
    const h = harness();
    const token = h.changes.backup({ kind, groupId: 'back', id });

    await h.changes.restore(token);

    expect(h.port.invocations.at(-1)?.channel).toBe(channel);
  });

  it('restores a deleted action and a deleted pre-script with its workflows', async () => {
    const h = harness();
    const action = h.changes.backup({
      kind: 'action',
      groupId: 'back',
      id: 'build',
    });
    const script = h.changes.backup({
      kind: 'prescript',
      groupId: 'back',
      id: 'vpn',
    });
    const back = groupNamed(h, 'back');
    if (back) {
      back.actions = [];
      back.preScripts = [];
    }
    h.runtime.workflows = [];

    await h.changes.restore(action);
    await h.changes.restore(script);

    expect(groupNamed(h, 'back')?.actions[0]?.id).toBe('build');
    expect(groupNamed(h, 'back')?.preScripts[0]?.id).toBe('vpn');
    expect(h.runtime.workflows).toHaveLength(1);
  });

  it('restores or removes a workflow', async () => {
    const h = harness();
    const existing = h.changes.backup({ kind: 'workflow', id: 'boot' });
    const created = h.changes.backup({ kind: 'workflow', id: 'new' });
    h.runtime.workflows = [];

    await h.changes.restore(existing);
    await h.changes.restore(created);

    expect(h.port.invocations.map((i) => i.channel)).toEqual([
      'workflows:save',
      'workflows:delete',
    ]);
  });

  it('replaces everything for an import', async () => {
    const h = harness();
    const token = h.changes.backup({ kind: 'all' });
    h.runtime.groups = [];

    await h.changes.restore(token);

    expect(h.runtime.groups).toHaveLength(2);
  });

  it('reports a backup that is gone, a vanished group and a throwing handler', async () => {
    const h = harness();
    expect(await h.changes.restore('missing')).toEqual({
      ok: false,
      error: 'La copia de ese cambio ya no existe',
    });

    const command = h.changes.backup({
      kind: 'command',
      groupId: 'back',
      id: 'normal',
    });
    h.runtime.groups = [];
    expect(await h.changes.restore(command)).toEqual({
      ok: false,
      error: 'No se pudo restaurar el comando: su grupo ya no existe',
    });

    const workflow = h.changes.backup({ kind: 'workflow', id: 'boot' });
    h.port.invoke = () =>
      Promise.reject(new Error('Ya hay un workflow de arranque'));
    expect(await h.changes.restore(workflow)).toEqual({
      ok: false,
      error: 'Ya hay un workflow de arranque',
    });
  });
});
