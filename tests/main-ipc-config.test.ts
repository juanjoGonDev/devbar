import { describe, expect, it } from 'vitest';
import {
  registerConfigIpc,
  type ConfigIpcDeps,
} from '../src/main/ipc/config-ipc.js';
import {
  makeAction,
  makeCommand,
  makeGroup,
  makeSettings,
  recordingIpc,
} from './helpers/main-fakes.js';
import type { Group } from '../src/domain-types.js';

function harness(groups: Group[] = [], overrides: Partial<ConfigIpcDeps> = {}) {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const themes: string[] = [];
  const groupErrors = new Map<string, string | null>();
  const stopResults = new Map<string, { ok: boolean; error?: string }>();
  const configStore = {
    listGroups: () => groups,
    getGroup: (id: string) => groups.find((g) => g.id === id) ?? null,
    saveGroup: (data: unknown) => {
      saved.push(data);
      return data as never;
    },
    deleteGroup: (id: string) => calls.push(`deleteGroup:${id}`),
    reorderGroups: (ids: readonly string[]) =>
      calls.push(`reorderGroups:${ids.join(',')}`),
    saveCommand: (groupId: string, data: unknown) => {
      saved.push({ groupId, data });
      return null;
    },
    deleteCommand: (g: string, c: string) =>
      calls.push(`deleteCommand:${g}:${c}`),
    reorderCommands: (g: string, ids: readonly string[]) =>
      calls.push(`reorderCommands:${g}:${ids.join(',')}`),
    saveAction: (groupId: string, data: unknown) => {
      saved.push({ groupId, data });
      return null;
    },
    deleteAction: (g: string, a: string) =>
      calls.push(`deleteAction:${g}:${a}`),
    reorderActions: (g: string, ids: readonly string[]) =>
      calls.push(`reorderActions:${g}:${ids.join(',')}`),
    getPreSteps: () => [],
    savePreStep: (data: unknown) => {
      saved.push(data);
      return null as never;
    },
    deletePreStep: (id: string) => calls.push(`deletePreStep:${id}`),
    reorderPreSteps: (ids: readonly string[]) =>
      calls.push(`reorderPreSteps:${ids.join(',')}`),
    assignScriptToStep: (...args: unknown[]) => {
      calls.push(`assign:${args.join(',')}`);
      return null as never;
    },
    unassignScriptFromStep: (...args: unknown[]) => {
      calls.push(`unassign:${args.join(',')}`);
      return null as never;
    },
    savePreScript: (groupId: string, data: unknown) => {
      saved.push({ groupId, data });
      return null as never;
    },
    deletePreScript: (g: string, s: string) =>
      calls.push(`deletePreScript:${g}:${s}`),
    reorderPreScripts: (g: string, ids: readonly string[]) =>
      calls.push(`reorderPreScripts:${g}:${ids.join(',')}`),
    addSilencedPattern: (g: string, c: string) =>
      c === 'missing' ? null : makeCommand({ id: c }),
    removeSilencedPattern: (g: string, c: string) =>
      c === 'missing' ? null : makeCommand({ id: c }),
    setCommandSilence: (g: string, c: string) =>
      c === 'missing' ? null : makeCommand({ id: c }),
    setGroupSilence: (g: string) =>
      g === 'missing' ? null : makeGroup({ id: g }),
    getGlobalSettings: () => makeSettings(),
    saveGlobalSettings: (patch: Record<string, unknown>) => ({
      ...makeSettings(),
      ...patch,
    }),
  } as unknown as ConfigIpcDeps['configStore'];
  const ipc = recordingIpc();
  registerConfigIpc(ipc, {
    configStore,
    processManager: {
      stop: (id) => Promise.resolve(stopResults.get(id) ?? { ok: true }),
      removeState: (id) => calls.push(`removeState:${id}`),
      recount: (id) => calls.push(`recount:${id}`),
    },
    snapshots: { snapshotGroupStates: () => [] },
    syncRepoWatchers: () => calls.push('syncRepoWatchers'),
    broadcast: () => calls.push('broadcast'),
    groupErrors,
    applyAutostart: (enabled) => calls.push(`autostart:${enabled}`),
    refreshWindowBackgrounds: () => calls.push('repaint'),
    sendTheme: (theme) => themes.push(theme),
    ...overrides,
  });
  return { ipc, calls, saved, themes, groupErrors, stopResults };
}

describe('src/main/ipc/config-ipc.ts', () => {
  describe('registration', () => {
    it('claims every configuration channel', () => {
      const h = harness();
      expect(h.ipc.channels()).toEqual(
        expect.arrayContaining([
          'groups:list',
          'groups:states',
          'groups:save',
          'groups:delete',
          'groups:reorder',
          'commands:save',
          'commands:delete',
          'commands:reorder',
          'commands:setAutoStart',
          'actions:save',
          'actions:delete',
          'actions:reorder',
          'pipeline:list',
          'preSteps:save',
          'preSteps:delete',
          'preSteps:reorder',
          'preSteps:assignScript',
          'preSteps:unassignScript',
          'preScripts:save',
          'preScripts:delete',
          'preScripts:reorder',
          'silence:add',
          'silence:remove',
          'silence:setCommand',
          'silence:setGroup',
          'settings:get',
          'settings:save',
        ]),
      );
    });
  });

  describe('groups', () => {
    it('lists groups and their runtime states', () => {
      const h = harness([makeGroup()]);
      expect(h.ipc.invoke('groups:list')).toHaveLength(1);
      expect(h.ipc.invoke('groups:states')).toEqual([]);
    });

    it('resyncs the repo watchers after a save', () => {
      const h = harness();
      h.ipc.invoke('groups:save', { id: 'g1' });
      expect(h.calls).toEqual(['syncRepoWatchers', 'broadcast']);
    });

    it('stops everything a group owns before deleting it', async () => {
      const group = makeGroup({
        commands: [makeCommand({ id: 'c1' })],
        actions: [makeAction({ id: 'a1' })],
      });
      const h = harness([group]);
      await expect(h.ipc.invoke('groups:delete', 'g1')).resolves.toEqual({
        ok: true,
      });
      expect(h.calls).toContain('removeState:cmd:g1:c1');
      expect(h.calls).toContain('removeState:act:g1:a1');
      expect(h.calls).toContain('deleteGroup:g1');
    });

    it('aborts the deletion when a command will not stop', async () => {
      const group = makeGroup({ commands: [makeCommand({ id: 'c1' })] });
      const h = harness([group]);
      h.stopResults.set('cmd:g1:c1', { ok: false, error: 'wedged' });
      await expect(h.ipc.invoke('groups:delete', 'g1')).resolves.toEqual({
        ok: false,
        error: 'wedged',
      });
      expect(h.calls).not.toContain('deleteGroup:g1');
    });

    it('names the command when the stop gave no reason', async () => {
      const group = makeGroup({
        commands: [makeCommand({ id: 'c1', name: 'web' })],
      });
      const h = harness([group]);
      h.stopResults.set('cmd:g1:c1', { ok: false });
      await expect(h.ipc.invoke('groups:delete', 'g1')).resolves.toEqual({
        ok: false,
        error: 'No se pudo parar «web» para borrarlo',
      });
    });

    it('aborts the deletion when an action will not stop', async () => {
      const group = makeGroup({
        actions: [makeAction({ id: 'a1', name: 'seed' })],
      });
      const h = harness([group]);
      h.stopResults.set('act:g1:a1', { ok: false });
      await expect(h.ipc.invoke('groups:delete', 'g1')).resolves.toEqual({
        ok: false,
        error: 'No se pudo parar «seed» para borrarlo',
      });
    });

    it('deletes a group that is already gone from the store', async () => {
      const h = harness();
      await expect(h.ipc.invoke('groups:delete', 'ghost')).resolves.toEqual({
        ok: true,
      });
    });

    it('clears the group transient error on delete', async () => {
      const h = harness([makeGroup()]);
      h.groupErrors.set('g1', 'git failed');
      await h.ipc.invoke('groups:delete', 'g1');
      expect(h.groupErrors.has('g1')).toBe(false);
    });

    it('reorders groups and rejects a non-string list', () => {
      const h = harness();
      expect(h.ipc.invoke('groups:reorder', ['a', 'b'])).toEqual({ ok: true });
      expect(h.calls).toContain('reorderGroups:a,b');
      expect(() => h.ipc.invoke('groups:reorder', ['a', 1])).toThrow(
        /Invalid IPC groupIds/,
      );
    });
  });

  describe('commands', () => {
    it('saves, reorders and broadcasts', () => {
      const h = harness();
      h.ipc.invoke('commands:save', {
        groupId: 'g1',
        commandData: { id: 'c1' },
      });
      h.ipc.invoke('commands:reorder', { groupId: 'g1', commandIds: ['c1'] });
      expect(h.saved[0]).toEqual({ groupId: 'g1', data: { id: 'c1' } });
      expect(h.calls).toContain('reorderCommands:g1:c1');
    });

    it('stops a command before deleting it', async () => {
      const h = harness();
      await expect(
        h.ipc.invoke('commands:delete', { groupId: 'g1', commandId: 'c1' }),
      ).resolves.toEqual({ ok: true });
      expect(h.calls).toContain('deleteCommand:g1:c1');
    });

    it('keeps a command whose process would not stop', async () => {
      const h = harness();
      h.stopResults.set('cmd:g1:c1', { ok: false });
      await expect(
        h.ipc.invoke('commands:delete', { groupId: 'g1', commandId: 'c1' }),
      ).resolves.toEqual({
        ok: false,
        error: 'No se pudo parar el comando para borrarlo',
      });
      expect(h.calls).not.toContain('deleteCommand:g1:c1');
    });

    it('flags a missing group or command on setAutoStart', () => {
      const h = harness([makeGroup({ commands: [makeCommand({ id: 'c1' })] })]);
      expect(
        h.ipc.invoke('commands:setAutoStart', {
          groupId: 'ghost',
          commandId: 'c1',
          enabled: true,
        }),
      ).toEqual({ ok: false, error: 'group not found' });
      expect(
        h.ipc.invoke('commands:setAutoStart', {
          groupId: 'g1',
          commandId: 'ghost',
          enabled: true,
        }),
      ).toEqual({ ok: false, error: 'command not found' });
    });

    it('turns autoStart on without touching the others in multi mode', () => {
      const h = harness([
        makeGroup({
          commands: [
            makeCommand({ id: 'c1' }),
            makeCommand({ id: 'c2', autoStart: true }),
          ],
        }),
      ]);
      h.ipc.invoke('commands:setAutoStart', {
        groupId: 'g1',
        commandId: 'c1',
        enabled: true,
      });
      const group = h.saved[0] as Group;
      expect(group.commands.map((c) => c.autoStart)).toEqual([true, true]);
    });

    it('clears the others in single mode, which is radio semantics', () => {
      const h = harness([
        makeGroup({
          mode: 'single',
          commands: [
            makeCommand({ id: 'c1' }),
            makeCommand({ id: 'c2', autoStart: true }),
          ],
        }),
      ]);
      h.ipc.invoke('commands:setAutoStart', {
        groupId: 'g1',
        commandId: 'c1',
        enabled: true,
      });
      const group = h.saved[0] as Group;
      expect(group.commands.map((c) => c.autoStart)).toEqual([true, false]);
    });

    it('leaves the others alone when turning autoStart OFF in single mode', () => {
      const h = harness([
        makeGroup({
          mode: 'single',
          commands: [
            makeCommand({ id: 'c1', autoStart: true }),
            makeCommand({ id: 'c2', autoStart: true }),
          ],
        }),
      ]);
      h.ipc.invoke('commands:setAutoStart', {
        groupId: 'g1',
        commandId: 'c1',
        enabled: false,
      });
      const group = h.saved[0] as Group;
      expect(group.commands.map((c) => c.autoStart)).toEqual([false, true]);
    });
  });

  describe('actions and the pipeline', () => {
    it('saves, deletes and reorders actions', () => {
      const h = harness();
      h.ipc.invoke('actions:save', { groupId: 'g1', actionData: { id: 'a1' } });
      h.ipc.invoke('actions:delete', { groupId: 'g1', actionId: 'a1' });
      h.ipc.invoke('actions:reorder', { groupId: 'g1', actionIds: ['a1'] });
      expect(h.calls).toContain('deleteAction:g1:a1');
      expect(h.calls).toContain('reorderActions:g1:a1');
    });

    it('edits the pipeline steps and their script assignments', () => {
      const h = harness();
      expect(h.ipc.invoke('pipeline:list')).toEqual([]);
      h.ipc.invoke('preSteps:save', { data: { id: 's1' } });
      h.ipc.invoke('preSteps:delete', { stepId: 's1' });
      h.ipc.invoke('preSteps:reorder', { orderedIds: ['s1', 's2'] });
      h.ipc.invoke('preSteps:assignScript', {
        stepId: 's1',
        groupId: 'g1',
        scriptId: 'p1',
        position: 0,
      });
      h.ipc.invoke('preSteps:unassignScript', {
        stepId: 's1',
        groupId: 'g1',
        scriptId: 'p1',
      });
      expect(h.calls).toContain('assign:s1,g1,p1,0');
      expect(h.calls).toContain('unassign:s1,g1,p1');
    });

    it('treats an absent position as unspecified', () => {
      const h = harness();
      h.ipc.invoke('preSteps:assignScript', {
        stepId: 's1',
        groupId: 'g1',
        scriptId: 'p1',
      });
      expect(h.calls).toContain('assign:s1,g1,p1,');
    });

    it('edits a group pre-script', () => {
      const h = harness();
      h.ipc.invoke('preScripts:save', { groupId: 'g1', data: { id: 'p1' } });
      h.ipc.invoke('preScripts:delete', { groupId: 'g1', scriptId: 'p1' });
      h.ipc.invoke('preScripts:reorder', { groupId: 'g1', orderedIds: ['p1'] });
      expect(h.calls).toContain('deletePreScript:g1:p1');
      expect(h.calls).toContain('reorderPreScripts:g1:p1');
    });
  });

  describe('silence', () => {
    it('recounts the command after adding or removing a pattern', () => {
      const h = harness();
      expect(
        h.ipc.invoke('silence:add', {
          groupId: 'g1',
          commandId: 'c1',
          level: 'warn',
          pattern: 'EADDR',
        }),
      ).toMatchObject({ ok: true });
      expect(
        h.ipc.invoke('silence:remove', {
          groupId: 'g1',
          commandId: 'c1',
          level: 'error',
          pattern: 'EADDR',
        }),
      ).toMatchObject({ ok: true });
      expect(h.calls.filter((c) => c === 'recount:cmd:g1:c1')).toHaveLength(2);
    });

    it('does not recount when the command no longer exists', () => {
      const h = harness();
      expect(
        h.ipc.invoke('silence:add', {
          groupId: 'g1',
          commandId: 'missing',
          level: 'warn',
          pattern: 'x',
        }),
      ).toMatchObject({ ok: false });
      expect(h.calls).not.toContain('recount:cmd:g1:missing');
    });

    it('toggles command and group silencing', () => {
      const h = harness();
      expect(
        h.ipc.invoke('silence:setCommand', {
          groupId: 'g1',
          commandId: 'c1',
          level: 'warn',
          enabled: true,
        }),
      ).toMatchObject({ ok: true });
      expect(
        h.ipc.invoke('silence:setGroup', {
          groupId: 'g1',
          level: 'error',
          enabled: true,
        }),
      ).toMatchObject({ ok: true });
    });

    it('reports a toggle that matched nothing', () => {
      const h = harness();
      expect(
        h.ipc.invoke('silence:setCommand', {
          groupId: 'g1',
          commandId: 'missing',
          level: 'warn',
          enabled: true,
        }),
      ).toMatchObject({ ok: false });
      expect(
        h.ipc.invoke('silence:setGroup', {
          groupId: 'missing',
          level: 'warn',
          enabled: true,
        }),
      ).toMatchObject({ ok: false });
    });
  });

  describe('settings', () => {
    it('reads the current settings', () => {
      const h = harness();
      expect(h.ipc.invoke('settings:get')).toMatchObject({ theme: 'auto' });
    });

    it('applies autostart and pushes the theme on its own channel', () => {
      const h = harness();
      h.ipc.invoke('settings:save', { autostart: true, theme: 'dark' });
      expect(h.calls).toContain('autostart:true');
      expect(h.calls).toContain('repaint');
      expect(h.themes).toEqual(['dark']);
    });
  });
});
