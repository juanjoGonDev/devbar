import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/config-store/workflow-store.ts` — the workflows (each a pre-script
 * graph with its own trigger), their last runs, and the per-group script
 * definitions their blocks point at.
 *
 * The referential-integrity pass matters most here: a block holds only
 * {groupId, scriptId} references, so every write has to re-derive them
 * against the groups that actually exist, or a workflow ends up trying to
 * run scripts that are gone.
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
import type { ConfigStoreModule } from './helpers/config-store.js';

const harness = configStoreHarness(electronState);

function groupWithScripts(name: string, scriptIds: string[]) {
  return {
    id: `g-${name}`,
    name,
    path: `/repos/${name}`,
    mode: 'multi',
    preScripts: scriptIds.map((id) => ({
      id,
      name: id,
      command: `make ${id}`,
    })),
  };
}

const SETUP = { groupId: 'g-api', scriptId: 'setup' };
const SEED = { groupId: 'g-api', scriptId: 'seed' };

/** trigger → setup → seed, laid out by hand. */
const CHAIN = {
  blocks: [
    { id: 'b1', scripts: [SETUP], x: 100, y: 40, requireAll: true },
    { id: 'b2', scripts: [SEED], x: 380, y: 40, requireAll: true },
  ],
  edges: [
    { from: 'trigger', to: 'b1' },
    { from: 'b1', to: 'b2' },
  ],
};

const MANUAL = { kind: 'manual', confirm: false } as const;

function startup(graph: unknown = CHAIN) {
  return {
    id: 'w-start',
    name: 'Arranque',
    enabled: true,
    showInTray: true,
    showInRemote: true,
    trigger: { kind: 'startup' },
    graph,
  };
}

/** A store holding one group with two scripts and a startup workflow. */
async function storeWithWorkflow(): Promise<ConfigStoreModule> {
  const store = await harness.open();
  store.saveGroup(groupWithScripts('api', ['setup', 'seed']));
  store.saveWorkflow(startup());
  return store;
}

const graphOf = (store: ConfigStoreModule, id = 'w-start') =>
  store.getWorkflow(id)?.graph;

describe('src/config-store/workflow-store.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  describe('workflows', () => {
    it('starts with none', async () => {
      const store = await harness.open();

      expect(store.listWorkflows()).toEqual([]);
    });

    it('stores exactly the workflow it is given, graph positions included', async () => {
      const store = await storeWithWorkflow();

      expect(store.listWorkflows()).toEqual([startup()]);
    });

    it('hands back what it stored', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup', 'seed']));

      expect(store.saveWorkflow(startup())).toEqual(startup());
    });

    it('creates an enabled workflow with an empty graph', async () => {
      const store = await harness.open();

      const created = store.createWorkflow('Backup', MANUAL);

      expect(created).toMatchObject({
        name: 'Backup',
        enabled: true,
        trigger: MANUAL,
        graph: { blocks: [], edges: [] },
      });
      expect(store.listWorkflows()).toEqual([created]);
    });

    it('refuses to create a second startup workflow', async () => {
      const store = await storeWithWorkflow();

      expect(() => store.createWorkflow('Otro', { kind: 'startup' })).toThrow(
        'Ya hay un workflow de arranque',
      );
    });

    it('refuses a graph with a cycle, and keeps the stored one', async () => {
      const store = await storeWithWorkflow();

      expect(() =>
        store.saveWorkflow(
          startup({
            ...CHAIN,
            edges: [...CHAIN.edges, { from: 'b2', to: 'b1' }],
          }),
        ),
      ).toThrow('El pipeline tiene un ciclo');
      expect(graphOf(store)).toEqual(CHAIN);
    });

    it('refuses a script placed twice in one workflow', async () => {
      const store = await storeWithWorkflow();

      expect(() =>
        store.saveWorkflow(
          startup({
            blocks: [
              { id: 'b1', scripts: [SETUP], x: 0, y: 0 },
              { id: 'b2', scripts: [SETUP], x: 0, y: 0 },
            ],
            edges: [],
          }),
        ),
      ).toThrow('Un script aparece en más de un bloque');
    });

    it('lets the same script appear in two workflows', async () => {
      const store = await storeWithWorkflow();

      store.saveWorkflow({ ...startup(), id: 'w-2', trigger: MANUAL });

      expect(graphOf(store, 'w-2')).toEqual(CHAIN);
    });

    it('refuses a second startup workflow on save', async () => {
      const store = await storeWithWorkflow();

      expect(() => store.saveWorkflow({ ...startup(), id: 'w-2' })).toThrow(
        'Ya hay un workflow de arranque',
      );
    });

    it('moves the startup trigger and leaves the old one manual where it showed', async () => {
      const store = await storeWithWorkflow();
      const other = store.createWorkflow('Backup', MANUAL);

      store.makeStartupWorkflow(other.id);

      expect(store.getWorkflow(other.id)?.trigger).toEqual({ kind: 'startup' });
      expect(store.getWorkflow('w-start')).toMatchObject({
        trigger: MANUAL,
        showInTray: true,
        showInRemote: true,
      });
    });

    it('turns a workflow off and back on', async () => {
      const store = await storeWithWorkflow();

      expect(store.setWorkflowEnabled('w-start', false)?.enabled).toBe(false);
      expect(store.getWorkflow('w-start')?.enabled).toBe(false);
      expect(store.setWorkflowEnabled('nope', true)).toBeNull();
    });

    it('deletes a workflow and its last run', async () => {
      const store = await storeWithWorkflow();
      store.recordWorkflowRun('w-start', {
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        result: 'success',
      });

      store.deleteWorkflow('w-start');

      expect(store.listWorkflows()).toEqual([]);
      expect(store.getWorkflowRuns()).toEqual({});
    });

    it('remembers the last run of each workflow across sessions', async () => {
      const store = await storeWithWorkflow();
      const run = {
        startedAt: 1000,
        finishedAt: 4000,
        durationMs: 3000,
        result: 'warning' as const,
      };
      store.recordWorkflowRun('w-start', run);

      const second = await harness.open({ home: harness.home() });

      expect(second.getWorkflowRuns()).toEqual({ 'w-start': run });
    });

    it('stores the workflows under `workflows`, with no `pipeline` or `preSteps`', async () => {
      await storeWithWorkflow();

      const disk = harness.onDisk();
      expect(disk.workflows).toEqual([startup()]);
      expect(disk).not.toHaveProperty('pipeline');
      expect(disk).not.toHaveProperty('preSteps');
    });
  });

  describe('migrating a store written before workflows', () => {
    it('turns the pipeline into the startup workflow «Arranque»', async () => {
      const store = await harness.open({
        seed: {
          version: 4,
          groups: [groupWithScripts('api', ['setup', 'seed'])],
          pipeline: CHAIN,
          globalSettings: { preScriptsAutoRun: true },
        },
      });

      expect(store.listWorkflows()).toEqual([
        expect.objectContaining({
          name: 'Arranque',
          enabled: true,
          trigger: { kind: 'startup' },
          graph: CHAIN,
        }),
      ]);
      const disk = harness.onDisk();
      expect(disk).not.toHaveProperty('pipeline');
      expect(disk.globalSettings).not.toHaveProperty('preScriptsAutoRun');
    });

    it('chains the old steps from the trigger and forgets `preSteps`', async () => {
      const store = await harness.open({
        seed: {
          version: 4,
          groups: [groupWithScripts('api', ['setup', 'seed'])],
          preSteps: [
            { id: 's1', mode: 'parallel', scripts: [SETUP] },
            { id: 's2', mode: 'serial', scripts: [SEED] },
          ],
        },
      });

      const [migrated] = store.listWorkflows();
      expect(migrated?.enabled).toBe(false);
      expect(migrated?.graph.blocks.map((block) => block.id)).toEqual([
        's1',
        's2',
      ]);
      expect(migrated?.graph.edges).toEqual([
        { from: 'trigger', to: 's1' },
        { from: 's1', to: 's2' },
      ]);
      expect(harness.onDisk()).not.toHaveProperty('preSteps');
    });
  });

  describe('referential integrity', () => {
    it('drops a reference to a script that has just been deleted', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup', 'seed']));
      store.saveWorkflow(
        startup({
          blocks: [{ id: 'b1', scripts: [SETUP, SEED], x: 0, y: 0 }],
          edges: [{ from: 'trigger', to: 'b1' }],
        }),
      );

      store.deletePreScript('g-api', 'setup');

      expect(graphOf(store)?.blocks).toEqual([
        { id: 'b1', scripts: [SEED], x: 0, y: 0, requireAll: true },
      ]);
    });

    it('bridges an emptied block so what came after it still runs', async () => {
      const store = await storeWithWorkflow();

      store.deletePreScript('g-api', 'setup');

      expect(graphOf(store)).toEqual({
        blocks: [CHAIN.blocks[1]],
        edges: [{ from: 'trigger', to: 'b2' }],
      });
    });

    it('drops every reference into a group that has just been deleted', async () => {
      const store = await storeWithWorkflow();

      store.deleteGroup('g-api');

      expect(graphOf(store)).toEqual({ blocks: [], edges: [] });
    });

    it('never stores a reference to a script that does not exist', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup']));

      store.saveWorkflow(
        startup({
          blocks: [
            {
              id: 'b1',
              scripts: [SETUP, { groupId: 'g-api', scriptId: 'ghost' }],
              x: 0,
              y: 0,
            },
          ],
          edges: [{ from: 'trigger', to: 'b1' }],
        }),
      );

      expect(graphOf(store)?.blocks[0]?.scripts).toEqual([SETUP]);
    });

    it('hands the workflows back to the next session unchanged', async () => {
      await storeWithWorkflow();

      const second = await harness.open({ home: harness.home() });

      expect(second.listWorkflows()).toEqual([startup()]);
    });
  });

  describe('group visibility in the tray', () => {
    it('hides and shows a group without touching anything else', async () => {
      const store = await storeWithWorkflow();

      expect(store.setGroupHiddenInTray('g-api', true)?.hiddenInTray).toBe(
        true,
      );
      expect(store.getGroup('g-api')?.hiddenInTray).toBe(true);
      expect(store.setGroupHiddenInTray('g-api', false)?.hiddenInTray).toBe(
        false,
      );
      expect(store.setGroupHiddenInTray('g-nope', true)).toBeNull();
    });
  });

  describe('script definitions', () => {
    it('refuses to define a script on a group that does not exist', async () => {
      const store = await harness.open();

      expect(store.savePreScript('g-nope', { id: 's1' })).toBeNull();
    });

    it('adds a script to its own group', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', []));

      const saved = store.savePreScript('g-api', {
        id: 'setup',
        name: 'setup',
        command: 'make setup',
      });

      expect(saved).toMatchObject({ id: 'setup', command: 'make setup' });
      expect(store.getGroup('g-api')?.preScripts).toHaveLength(1);
    });

    it('replaces a script with the same id rather than duplicating it', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup']));

      store.savePreScript('g-api', {
        id: 'setup',
        name: 'setup',
        command: 'make new',
      });

      const scripts = store.getGroup('g-api')?.preScripts ?? [];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.command).toBe('make new');
    });

    it('deletes one script and keeps the others', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup', 'seed']));

      store.deletePreScript('g-api', 'setup');

      expect(
        store.getGroup('g-api')?.preScripts.map((script) => script.id),
      ).toEqual(['seed']);
    });

    it('ignores a script delete for an unknown group', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup']));

      store.deletePreScript('g-nope', 'setup');

      expect(store.getGroup('g-api')?.preScripts).toHaveLength(1);
    });

    it('reorders a group’s scripts', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['a', 'b', 'c']));

      store.reorderPreScripts('g-api', ['c', 'a']);

      expect(
        store.getGroup('g-api')?.preScripts.map((script) => script.id),
      ).toEqual(['c', 'a', 'b']);
    });

    it('ignores a script reorder for an unknown group', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['a', 'b']));

      store.reorderPreScripts('g-nope', ['b']);

      expect(
        store.getGroup('g-api')?.preScripts.map((script) => script.id),
      ).toEqual(['a', 'b']);
    });
  });
});
