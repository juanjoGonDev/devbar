import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `src/config-store.ts` — groups and everything nested in one (commands,
 * actions, silencing), plus whole-config import/export.
 *
 * Every case goes through the real `electron-store`, so "it persisted" means
 * the JSON on disk, not a stubbed setter.
 */

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  home: '',
  userData: '',
  version: '0.9.2',
}));

vi.mock('electron', () => {
  const app = {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: (name: string) =>
      name === 'home' ? electronState.home : electronState.userData,
    getVersion: () => electronState.version,
  };
  const electron = { app, ipcMain: { on: () => undefined }, shell: {} };
  return { ...electron, default: electron };
});

import { configStoreHarness } from './helpers/config-store.js';

const harness = configStoreHarness(electronState);

function group(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: `g-${name}`,
    name,
    path: `/repos/${name}`,
    mode: 'multi',
    ...extra,
  };
}

function command(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, command: `pnpm ${id}`, ...extra };
}

describe('src/config-store.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  describe('groups', () => {
    it('appends a new group at the end of the running order', async () => {
      const store = await harness.open();

      store.saveGroup(group('api'));
      const second = store.saveGroup(group('web'));

      expect(second.order).toBe(1);
      expect(store.listGroups().map((entry) => entry.name)).toEqual([
        'api',
        'web',
      ]);
    });

    it('updates a group in place instead of adding a second one', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));

      store.saveGroup(group('api', { name: 'API', icon: '🚀' }));

      const groups = store.listGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ name: 'API', icon: '🚀' });
    });

    it('reports when it had to switch off a single-mode group’s extra autostarts', async () => {
      const store = await harness.open();

      const saved = store.saveGroup(
        group('api', {
          mode: 'single',
          commands: [
            command('a', { autoStart: true }),
            command('b', { autoStart: true }),
          ],
        }),
      );

      expect(saved._autoStartEnforced).toBe(true);
      expect(
        store.getGroup('g-api')?.commands.map((entry) => entry.autoStart),
      ).toEqual([false, false]);
    });

    it('leaves a legal group alone and says so', async () => {
      const store = await harness.open();

      const saved = store.saveGroup(
        group('api', {
          mode: 'single',
          commands: [command('a', { autoStart: true }), command('b')],
        }),
      );

      expect(saved._autoStartEnforced).toBe(false);
    });

    it('finds a group by id, and answers null for one that is gone', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));

      expect(store.getGroup('g-api')?.name).toBe('api');
      expect(store.getGroup('g-nope')).toBeNull();
    });

    it('deletes a group and leaves the rest', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.saveGroup(group('web'));

      store.deleteGroup('g-api');

      expect(store.listGroups().map((entry) => entry.name)).toEqual(['web']);
    });

    it('ignores a delete for a group that is not there', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));

      store.deleteGroup('g-nope');

      expect(store.listGroups()).toHaveLength(1);
    });

    it('renumbers order to match the new arrangement', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.saveGroup(group('web'));
      store.saveGroup(group('db'));

      const sorted = store.reorderGroups(['g-db', 'g-api']);

      expect(sorted.map((entry) => [entry.name, entry.order])).toEqual([
        ['db', 0],
        ['api', 1],
        ['web', 2],
      ]);
      expect(store.listGroups().map((entry) => entry.name)).toEqual([
        'db',
        'api',
        'web',
      ]);
    });
  });

  describe('commands', () => {
    it('refuses to attach a command to a group that does not exist', async () => {
      const store = await harness.open();

      expect(store.saveCommand('g-nope', command('a'))).toBeNull();
    });

    it('adds a command and hands back what it stored', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));

      const saved = store.saveCommand('g-api', command('a'));

      expect(saved).toMatchObject({ id: 'a', command: 'pnpm a' });
      expect(store.getGroup('g-api')?.commands).toHaveLength(1);
    });

    it('replaces a command with the same id rather than duplicating it', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.saveCommand('g-api', command('a'));

      store.saveCommand('g-api', command('a', { command: 'pnpm start' }));

      const commands = store.getGroup('g-api')?.commands ?? [];
      expect(commands).toHaveLength(1);
      expect(commands[0]?.command).toBe('pnpm start');
    });

    it('deletes one command and keeps the others', async () => {
      const store = await harness.open();
      store.saveGroup(group('api', { commands: [command('a'), command('b')] }));

      store.deleteCommand('g-api', 'a');

      expect(store.getGroup('g-api')?.commands.map((c) => c.id)).toEqual(['b']);
    });

    it('ignores a command delete for an unknown group', async () => {
      const store = await harness.open();
      store.saveGroup(group('api', { commands: [command('a')] }));

      store.deleteCommand('g-nope', 'a');

      expect(store.getGroup('g-api')?.commands).toHaveLength(1);
    });

    it('reorders commands inside their group', async () => {
      const store = await harness.open();
      store.saveGroup(
        group('api', {
          commands: [command('a'), command('b'), command('c')],
        }),
      );

      store.reorderCommands('g-api', ['c', 'a']);

      expect(store.getGroup('g-api')?.commands.map((c) => c.id)).toEqual([
        'c',
        'a',
        'b',
      ]);
    });

    it('ignores a command reorder for an unknown group', async () => {
      const store = await harness.open();
      store.saveGroup(group('api', { commands: [command('a')] }));

      store.reorderCommands('g-nope', ['a']);

      expect(store.getGroup('g-api')?.commands.map((c) => c.id)).toEqual(['a']);
    });
  });

  describe('actions', () => {
    it('refuses to attach an action to a group that does not exist', async () => {
      const store = await harness.open();

      expect(store.saveAction('g-nope', command('a'))).toBeNull();
    });

    it('adds an action, then replaces it by id', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));

      store.saveAction('g-api', { id: 'a', name: 'build', command: 'make' });
      store.saveAction('g-api', {
        id: 'a',
        name: 'build',
        command: 'make all',
      });

      const actions = store.getGroup('g-api')?.actions ?? [];
      expect(actions).toHaveLength(1);
      expect(actions[0]?.command).toBe('make all');
    });

    it('deletes one action and keeps the others', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.saveAction('g-api', { id: 'a', name: 'a', command: 'make a' });
      store.saveAction('g-api', { id: 'b', name: 'b', command: 'make b' });

      store.deleteAction('g-api', 'a');

      expect(store.getGroup('g-api')?.actions.map((entry) => entry.id)).toEqual(
        ['b'],
      );
    });

    it('ignores an action delete for an unknown group', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.saveAction('g-api', { id: 'a', name: 'a', command: 'make a' });

      store.deleteAction('g-nope', 'a');

      expect(store.getGroup('g-api')?.actions).toHaveLength(1);
    });

    it('reorders actions inside their group', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      for (const id of ['a', 'b', 'c'])
        store.saveAction('g-api', { id, name: id, command: `make ${id}` });

      store.reorderActions('g-api', ['c', 'b']);

      expect(store.getGroup('g-api')?.actions.map((entry) => entry.id)).toEqual(
        ['c', 'b', 'a'],
      );
    });

    it('ignores an action reorder for an unknown group', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.saveAction('g-api', { id: 'a', name: 'a', command: 'make a' });

      store.reorderActions('g-nope', ['a']);

      expect(store.getGroup('g-api')?.actions.map((entry) => entry.id)).toEqual(
        ['a'],
      );
    });
  });

  describe('silencing', () => {
    async function storeWithCommand() {
      const store = await harness.open();
      store.saveGroup(group('api', { commands: [command('a')] }));
      return store;
    }

    it.each([
      ['an empty pattern', ''],
      ['a whitespace-only pattern', '   '],
    ])('refuses to silence on %s', async (_label, pattern) => {
      const store = await storeWithCommand();

      expect(
        store.addSilencedPattern('g-api', 'a', 'warn', pattern),
      ).toBeNull();
    });

    it.each([
      ['group', 'g-nope', 'a'],
      ['command', 'g-api', 'nope'],
    ])('refuses to silence for an unknown %s', async (_label, gid, cid) => {
      const store = await storeWithCommand();

      expect(store.addSilencedPattern(gid, cid, 'warn', 'noise')).toBeNull();
    });

    it.each(['warn', 'error'] as const)(
      'adds a %s pattern, trimmed',
      async (level) => {
        const store = await storeWithCommand();

        const updated = store.addSilencedPattern(
          'g-api',
          'a',
          level,
          '  noisy line  ',
        );

        expect(updated?.silencedPatterns[level]).toEqual(['noisy line']);
      },
    );

    it('does not add the same pattern twice', async () => {
      const store = await storeWithCommand();
      store.addSilencedPattern('g-api', 'a', 'warn', 'noise');

      const updated = store.addSilencedPattern('g-api', 'a', 'warn', 'noise');

      expect(updated?.silencedPatterns.warn).toEqual(['noise']);
    });

    it('keeps the other level untouched when adding', async () => {
      const store = await storeWithCommand();

      store.addSilencedPattern('g-api', 'a', 'warn', 'noise');

      expect(
        store.getGroup('g-api')?.commands[0]?.silencedPatterns.error,
      ).toEqual([]);
    });

    it('removes just the pattern asked for', async () => {
      const store = await storeWithCommand();
      store.addSilencedPattern('g-api', 'a', 'error', 'keep me');
      store.addSilencedPattern('g-api', 'a', 'error', 'drop me');

      const updated = store.removeSilencedPattern(
        'g-api',
        'a',
        'error',
        'drop me',
      );

      expect(updated?.silencedPatterns.error).toEqual(['keep me']);
    });

    it('refuses to remove a pattern from an unknown command', async () => {
      const store = await storeWithCommand();

      expect(
        store.removeSilencedPattern('g-api', 'nope', 'error', 'x'),
      ).toBeNull();
    });

    it.each([
      ['warn', 'silenceWarnings'],
      ['error', 'silenceErrors'],
    ] as const)('mutes %s for one command', async (level, flag) => {
      const store = await storeWithCommand();

      const updated = store.setCommandSilence('g-api', 'a', level, true);

      expect(updated?.[flag]).toBe(true);
      expect(store.getGroup('g-api')?.commands[0]?.[flag]).toBe(true);
    });

    it('refuses to mute an unknown command', async () => {
      const store = await storeWithCommand();

      expect(store.setCommandSilence('g-api', 'nope', 'warn', true)).toBeNull();
    });

    it.each([
      ['warn', 'silenceWarnings'],
      ['error', 'silenceErrors'],
    ] as const)('mutes %s for a whole group', async (level, flag) => {
      const store = await storeWithCommand();

      const updated = store.setGroupSilence('g-api', level, true);

      expect(updated?.[flag]).toBe(true);
      expect(store.getGroup('g-api')?.[flag]).toBe(true);
    });

    it('refuses to mute an unknown group', async () => {
      const store = await storeWithCommand();

      expect(store.setGroupSilence('g-nope', 'warn', true)).toBeNull();
    });
  });

  describe('export, import and the pre-import backup', () => {
    it('stamps the export with the running app version and the store version', async () => {
      electronState.version = '1.2.3';
      const store = await harness.open();
      store.saveGroup(group('api'));

      const exported = store.exportConfig();

      expect(exported.appVersion).toBe('1.2.3');
      expect(exported.version).toBe(4);
      expect(exported.groups.map((entry) => entry.name)).toEqual(['api']);
      expect(exported.globalSettings.maxLogLines).toBe(10_000);
      expect(Date.parse(exported.exportedAt)).not.toBeNaN();
    });

    it('replaces the whole config, not just the parts that were sent', async () => {
      const store = await harness.open();
      store.saveGroup(group('old'));

      store.replaceConfig({
        version: 4,
        groups: [group('imported')],
        preSteps: [{ id: 's1', mode: 'serial', scripts: [] }],
        globalSettings: { theme: 'dark' },
      });

      expect(store.listGroups().map((entry) => entry.name)).toEqual([
        'imported',
      ]);
      expect(store.getPreSteps().map((step) => step.id)).toEqual(['s1']);
      expect(store.getGlobalSettings().theme).toBe('dark');
    });

    it('applies the same autostart repair to an imported group', async () => {
      const store = await harness.open();

      store.replaceConfig({
        version: 4,
        groups: [
          group('api', {
            mode: 'single',
            commands: [
              command('a', { autoStart: true }),
              command('b', { autoStart: true }),
            ],
          }),
        ],
        globalSettings: {},
      });

      expect(
        store.getGroup('g-api')?.commands.map((entry) => entry.autoStart),
      ).toEqual([false, false]);
    });

    it('imports an empty pipeline when the payload carries no steps', async () => {
      const store = await harness.open();
      store.savePreStep({ id: 's1', mode: 'serial', scripts: [] });

      store.replaceConfig({
        version: 4,
        groups: [],
        globalSettings: {},
      });

      expect(store.getPreSteps()).toEqual([]);
    });

    it('sanitises the imported settings instead of trusting them', async () => {
      const store = await harness.open();

      store.replaceConfig({
        version: 4,
        groups: [],
        globalSettings: {
          theme: 'neon' as 'dark',
          maxLogLines: 10,
          autostart: 'yes' as unknown as boolean,
        },
      });

      expect(store.getGlobalSettings()).toMatchObject({
        theme: 'auto',
        maxLogLines: 100,
        autostart: true,
      });
    });

    it('writes a readable snapshot next to the store before an import', async () => {
      const store = await harness.open();
      store.saveGroup(group('api'));
      store.savePreStep({ id: 's1', mode: 'parallel', scripts: [] });

      const backupPath = store.writeImportBackup();

      expect(backupPath).toBe(
        path.join(harness.dir(), 'pre-import-backup.json'),
      );
      const snapshot = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as {
        version: number;
        groups: { name: string }[];
        preSteps: { id: string }[];
        backedUpAt: string;
        globalSettings: Record<string, unknown>;
      };
      expect(snapshot.version).toBe(4);
      expect(snapshot.groups.map((entry) => entry.name)).toEqual(['api']);
      expect(snapshot.preSteps.map((entry) => entry.id)).toEqual(['s1']);
      expect(Date.parse(snapshot.backedUpAt)).not.toBeNaN();
      expect(snapshot.globalSettings).toHaveProperty('maxLogLines');
    });
  });
});
