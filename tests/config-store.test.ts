import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `src/config-store/store.ts` — where the config file is opened, what the
 * schema migration writes back into it, and the two slices that are plain
 * values (globalSettings, scheduleState).
 *
 * These run against the REAL `electron-store`: only `electron` itself is
 * faked, so the schema, the JSON on disk and the read-back are all genuine.
 * That matters more here than anywhere else in the app — everything this
 * module gets wrong is a user's configuration silently lost or corrupted.
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
  // electron-store destructures the DEFAULT export, app-paths imports the
  // named one; both have to be the same object.
  const electron = { app, ipcMain: { on: () => undefined }, shell: {} };
  return { ...electron, default: electron };
});

/**
 * The real move is `app-paths`' job and has its own tests; what config-store
 * owns is how it REACTS to each outcome. Forcing the outcome is also the only
 * portable way to reach the 'failed' branch: on a case-insensitive filesystem
 * (macOS) `…/devbar` and `…/DevBar` are one directory, so the real migration
 * can only ever report 'skipped' there.
 */
const legacyMigration = vi.hoisted(() => ({
  forced: null as 'moved' | 'skipped' | 'failed' | null,
}));

vi.mock('../src/app-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-paths.js')>();
  return {
    ...actual,
    migrateLegacyLinuxStore: (
      ...args: Parameters<typeof actual.migrateLegacyLinuxStore>
    ) => legacyMigration.forced ?? actual.migrateLegacyLinuxStore(...args),
  };
});

import { configStoreHarness } from './helpers/config-store.js';

const harness = configStoreHarness(electronState);
const savedPlatform = process.platform;
let savedXdg: string | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function legacyGroup(name: string): Record<string, unknown> {
  return { id: `g-${name}`, name, path: `/repos/${name}`, mode: 'multi' };
}

describe('src/config-store/store.ts', () => {
  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    legacyMigration.forced = null;
  });

  afterEach(() => {
    setPlatform(savedPlatform);
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    vi.restoreAllMocks();
    harness.cleanup();
  });

  describe('where the store opens', () => {
    it('pins a packaged macOS build to the DevBar application-support folder', async () => {
      const store = await harness.open();

      store.saveGroup(legacyGroup('api'));

      expect(
        fs.existsSync(
          path.join(
            electronState.home,
            'Library',
            'Application Support',
            'DevBar',
            'config.json',
          ),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(electronState.home, 'config.json'))).toBe(
        false,
      );
    });

    it('migrates a pre-pin Linux config so the migration runs on real data', async () => {
      setPlatform('linux');
      electronState.isPackaged = true;
      const xdg = harness.scratch();
      electronState.home = xdg;
      process.env.XDG_CONFIG_HOME = xdg;
      const legacyDir = path.join(xdg, 'devbar');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ version: 4, groups: [legacyGroup('legacy')] }),
      );

      const store = await harness.load();

      // The user's real groups, not a fresh empty store.
      expect(store.listGroups().map((group) => group.name)).toEqual(['legacy']);
      expect(fs.existsSync(path.join(xdg, 'DevBar', 'config.json'))).toBe(true);
    });

    it('keeps serving the legacy Linux config when the move fails, instead of starting empty', async () => {
      setPlatform('linux');
      electronState.isPackaged = true;
      const xdg = harness.scratch();
      electronState.home = xdg;
      process.env.XDG_CONFIG_HOME = xdg;
      const legacyDir = path.join(xdg, 'devbar');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ version: 4, groups: [legacyGroup('legacy')] }),
      );
      legacyMigration.forced = 'failed';
      const errors = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      const store = await harness.load();

      expect(store.listGroups().map((group) => group.name)).toEqual(['legacy']);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('legacy config migration failed'),
      );
      // The backup must land where the store is ACTUALLY served from: writing
      // it to the pinned directory would throw before the import could apply.
      expect(store.writeImportBackup()).toBe(
        path.join(legacyDir, 'pre-import-backup.json'),
      );
    });
  });

  describe('the schema migration', () => {
    it('converts a legacy v1 services store into groups and keeps the originals as a backup', async () => {
      const service = {
        id: 'svc1',
        name: 'Dev',
        cwd: '/repo',
        command: 'pnpm dev',
        args: [],
        env: {},
        gitRepo: '/repo',
      };
      const store = await harness.open({
        seed: { version: 1, services: [service] },
      });

      const groups = store.listGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0]?.commands.map((command) => command.name)).toEqual([
        'Dev',
      ]);
      const raw = harness.onDisk();
      expect(raw.version).toBe(4);
      expect(raw._services_pre_v3_backup).toEqual([service]);
    });

    it('relabels a v3 store as v4 even when its content needed no change', async () => {
      const store = await harness.open({
        seed: { version: 3, groups: [], preSteps: [], globalSettings: {} },
      });

      // Left mislabelled, every export and backup of this store would claim
      // v3 forever.
      expect(harness.onDisk().version).toBe(4);
      expect(store.exportConfig().version).toBe(4);
    });

    it('leaves an already canonical v4 store exactly as it found it', async () => {
      const seed = {
        version: 4,
        groups: [],
        preSteps: [],
        services: [],
        globalSettings: { theme: 'dark' },
        scheduleState: {},
        _services_pre_v3_backup: [],
      };
      await harness.open({ seed });

      expect(harness.onDisk()).toEqual(seed);
    });

    it('hoists a group’s legacy preSteps into the global pipeline', async () => {
      const store = await harness.open({
        seed: {
          version: 3,
          groups: [
            {
              ...legacyGroup('api'),
              preSteps: [
                {
                  id: 'step1',
                  mode: 'serial',
                  scripts: [{ id: 'sc1', name: 'setup', command: 'make' }],
                },
              ],
            },
          ],
        },
      });

      const steps = store.getPreSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]?.scripts).toEqual([
        { groupId: 'g-api', scriptId: 'sc1' },
      ]);
      expect(
        store.listGroups()[0]?.preScripts.map((script) => script.id),
      ).toEqual(['sc1']);
    });

    it('carries a hoisted group’s preScriptsAutoRun into the global settings', async () => {
      const store = await harness.open({
        seed: {
          version: 3,
          groups: [
            {
              ...legacyGroup('api'),
              preScriptsAutoRun: true,
              preSteps: [
                {
                  id: 'step1',
                  mode: 'parallel',
                  scripts: [{ id: 'sc1', name: 'setup', command: 'make' }],
                },
              ],
            },
          ],
        },
      });

      expect(store.getGlobalSettings().preScriptsAutoRun).toBe(true);
    });

    it('leaves preScriptsAutoRun alone when no group actually contributed a script', async () => {
      const store = await harness.open({
        seed: {
          version: 4,
          groups: [{ ...legacyGroup('api'), preSteps: [] }],
          globalSettings: { preScriptsAutoRun: true },
        },
      });

      // The AND-fold over zero contributors is `false`; writing it would
      // silently switch off an auto-run the user had enabled.
      expect(store.getGlobalSettings().preScriptsAutoRun).toBe(true);
    });
  });

  describe('globalSettings', () => {
    it('answers with the defaults for a store that has never been written', async () => {
      const store = await harness.open();

      expect(store.getGlobalSettings()).toEqual({
        autostart: false,
        theme: 'auto',
        silenceWarnings: false,
        silenceErrors: false,
        maxLogLines: 10_000,
        notifySuccess: true,
        preScriptsAutoRun: false,
      });
    });

    it.each([
      ['below the floor', 5, 100],
      ['above the ceiling', 999_999, 50_000],
      ['fractional', 1234.7, 1234],
      ['zero', 0, 10_000],
      ['negative', -50, 10_000],
      ['not a number', 'many', 10_000],
      ['null', null, 10_000],
    ])('clamps a %s log limit', async (_label, value, expected) => {
      const store = await harness.open();

      const saved = store.saveGlobalSettings({
        maxLogLines: value as unknown as number,
      });

      expect(saved.maxLogLines).toBe(expected);
      expect(store.getGlobalSettings().maxLogLines).toBe(expected);
    });

    it.each([
      ['light', 'light'],
      ['dark', 'dark'],
      ['auto', 'auto'],
      ['solarized', 'auto'],
      ['', 'auto'],
    ])('resolves the %s theme', async (value, expected) => {
      const store = await harness.open();

      expect(store.saveGlobalSettings({ theme: value as 'light' }).theme).toBe(
        expected,
      );
    });

    it('coerces every flag to a real boolean', async () => {
      const store = await harness.open();

      const saved = store.saveGlobalSettings({
        autostart: 1 as unknown as boolean,
        silenceWarnings: '' as unknown as boolean,
        silenceErrors: 'yes' as unknown as boolean,
        notifySuccess: 0 as unknown as boolean,
        preScriptsAutoRun: null as unknown as boolean,
      });

      expect(saved).toMatchObject({
        autostart: true,
        silenceWarnings: false,
        silenceErrors: true,
        notifySuccess: false,
        preScriptsAutoRun: false,
      });
    });

    it('patches the stored settings instead of replacing them', async () => {
      const store = await harness.open();
      store.saveGlobalSettings({ theme: 'dark', notifySuccess: false });

      store.saveGlobalSettings({ autostart: true });

      expect(store.getGlobalSettings()).toMatchObject({
        theme: 'dark',
        notifySuccess: false,
        autostart: true,
      });
    });

    it('still has them after the app restarts', async () => {
      const first = await harness.open();
      first.saveGlobalSettings({ theme: 'dark', maxLogLines: 250 });

      const second = await harness.open({ home: harness.home() });

      expect(second.getGlobalSettings()).toMatchObject({
        theme: 'dark',
        maxLogLines: 250,
      });
    });
  });

  describe('scheduleState', () => {
    it('has no last run for a process that never ran', async () => {
      const store = await harness.open();

      expect(store.getScheduleLastRun('p1')).toBeNull();
    });

    it('remembers each process’ last run across a restart', async () => {
      const first = await harness.open();
      first.setScheduleLastRun('p1', '2024-01-01T00:00:00.000Z');
      first.setScheduleLastRun('p2', '2024-02-02T00:00:00.000Z');

      const second = await harness.open({ home: harness.home() });

      expect(second.getScheduleLastRun('p1')).toBe('2024-01-01T00:00:00.000Z');
      expect(second.getScheduleLastRun('p2')).toBe('2024-02-02T00:00:00.000Z');
    });

    it('overwrites one process’ stamp without touching the others', async () => {
      const store = await harness.open();
      store.setScheduleLastRun('p1', '2024-01-01T00:00:00.000Z');
      store.setScheduleLastRun('p2', '2024-02-02T00:00:00.000Z');

      store.setScheduleLastRun('p1', '2024-03-03T00:00:00.000Z');

      expect(store.getScheduleLastRun('p1')).toBe('2024-03-03T00:00:00.000Z');
      expect(store.getScheduleLastRun('p2')).toBe('2024-02-02T00:00:00.000Z');
    });
  });

  describe('every write', () => {
    it('keeps the legacy services mirror in step with the groups', async () => {
      const store = await harness.open();

      store.saveGroup({
        ...legacyGroup('api'),
        commands: [{ id: 'c1', name: 'dev', command: 'pnpm dev' }],
      });

      expect(harness.onDisk().services).toMatchObject([
        { name: 'dev', command: 'pnpm dev', cwd: '/repos/api' },
      ]);
    });

    it('hands the groups back to the next session unchanged', async () => {
      const first = await harness.open();
      first.saveGroup({ ...legacyGroup('api'), icon: '🚀' });
      first.saveGroup(legacyGroup('web'));

      const second = await harness.open({ home: harness.home() });

      expect(second.listGroups().map((group) => group.name)).toEqual([
        'api',
        'web',
      ]);
      expect(second.getGroup('g-api')?.icon).toBe('🚀');
    });
  });
});
