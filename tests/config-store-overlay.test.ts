import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The dev panel's "Grupos de prueba" overlay over `src/config-store.ts`:
 * while it is on, every group read and write goes to an in-memory list, and
 * the user's stored configuration must come out of it byte-for-byte as it
 * went in. Checked against the real `electron-store` file on disk.
 */

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  home: '',
  userData: '',
  version: '0.10.0',
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
import type { Group } from '../src/domain-types.js';

const harness = configStoreHarness(electronState);

function rawGroup(id: string, name: string) {
  return {
    id,
    name,
    path: `/repos/${name}`,
    mode: 'multi',
    commands: [{ id: 'dev', name: 'dev', command: 'pnpm dev' }],
    preScripts: [{ id: 'install', name: 'install', command: 'pnpm i' }],
  };
}

async function storeWithRealConfig() {
  const store = await harness.open();
  store.saveGroup(rawGroup('g-api', 'api'));
  store.saveGroup(rawGroup('g-web', 'web'));
  const step = store.savePreStep({ id: 's1', mode: 'serial', scripts: [] });
  store.assignScriptToStep(step.id, 'g-api', 'install');
  return store;
}

function fixtures(store: Awaited<ReturnType<typeof harness.open>>): Group[] {
  // Built through the same normalizer real groups go through.
  store.saveGroup(rawGroup('tmp', 'tmp'));
  const built = store.getGroup('tmp');
  store.deleteGroup('tmp');
  if (!built) throw new Error('fixture did not normalize');
  return [{ ...built, id: 'fixture-1-services', name: 'Prueba 1 · Servicios' }];
}

describe('src/config-store.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  describe('the groups overlay', () => {
    it('shows only the overlay groups while it is on', async () => {
      const store = await storeWithRealConfig();
      store.setGroupsOverlay(fixtures(store));

      expect(store.groupsOverlayActive()).toBe(true);
      expect(store.listGroups().map((g) => g.id)).toEqual([
        'fixture-1-services',
      ]);
      expect(store.getGroup('g-api')).toBeNull();
      expect(store.getPreSteps()).toEqual([]);
    });

    it('leaves the stored config untouched across on → edit → off', async () => {
      const store = await storeWithRealConfig();
      const before = harness.onDisk();
      store.setGroupsOverlay(fixtures(store));

      // Every kind of write the config window can make.
      store.saveGroup({ ...rawGroup('g-new', 'new') });
      store.saveGroup({ ...rawGroup('g-api', 'api'), name: 'hijacked' });
      store.deleteGroup('fixture-1-services');
      store.reorderGroups(['g-new', 'g-api']);
      store.saveCommand('g-new', { id: 'x', name: 'x', command: 'echo x' });
      store.saveAction('g-new', { id: 'a', name: 'a', command: 'echo a' });
      store.savePreScript('g-new', { id: 'p', name: 'p', command: 'echo p' });
      store.savePreStep({ id: 's2', mode: 'parallel', scripts: [] });
      store.setGroupSilence('g-new', 'warn', true);

      expect(harness.onDisk()).toEqual(before);
      store.setGroupsOverlay(null);
      expect(harness.onDisk()).toEqual(before);
      expect(store.groupsOverlayActive()).toBe(false);
      expect(store.listGroups().map((g) => g.name)).toEqual(['api', 'web']);
      expect(store.getPreSteps().map((s) => s.id)).toEqual(['s1']);
    });

    it('keeps edits made while on in memory, on the overlay groups', async () => {
      const store = await storeWithRealConfig();
      store.setGroupsOverlay(fixtures(store));

      store.saveCommand('fixture-1-services', {
        id: 'extra',
        name: 'extra',
        command: 'echo extra',
      });

      expect(
        store.getGroup('fixture-1-services')?.commands.map((c) => c.id),
      ).toEqual(['dev', 'extra']);
    });

    it('does not let a caller mutate the overlay through what it read', async () => {
      const store = await storeWithRealConfig();
      store.setGroupsOverlay(fixtures(store));

      const read = store.listGroups();
      if (read[0]) read[0].name = 'mutated';

      expect(store.listGroups()[0]?.name).toBe('Prueba 1 · Servicios');
    });

    it('exports the stored groups, never the overlay', async () => {
      const store = await storeWithRealConfig();
      store.setGroupsOverlay(fixtures(store));

      const exported = JSON.stringify(store.exportConfig());

      expect(exported).toContain('g-api');
      expect(exported).not.toContain('fixture-');
    });

    it('refuses an import while it is on', async () => {
      const store = await storeWithRealConfig();
      const before = harness.onDisk();
      store.setGroupsOverlay(fixtures(store));

      expect(() =>
        store.replaceConfig({ version: 3, groups: [], globalSettings: {} }),
      ).toThrow(/Modo grupos de prueba activo/);
      expect(harness.onDisk()).toEqual(before);
    });
  });
});
