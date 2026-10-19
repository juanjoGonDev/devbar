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
import type {
  Group,
  Workflow,
  WorkflowRunRecord,
} from '../src/domain-types.js';

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
  store.saveWorkflow({
    id: 'w-start',
    name: 'Arranque',
    trigger: { kind: 'startup' },
    graph: {
      blocks: [
        {
          id: 's1',
          scripts: [{ groupId: 'g-api', scriptId: 'install' }],
          x: 0,
          y: 0,
        },
      ],
      edges: [{ from: 'trigger', to: 's1' }],
    },
  });
  store.recordWorkflowRun('w-start', {
    startedAt: 1000,
    finishedAt: 4000,
    durationMs: 3000,
    result: 'warning',
  });
  store.setScheduleLastRun('cmd:g-api:dev', '2026-10-01T08:00:00.000Z');
  return store;
}

const FIXTURE_WORKFLOW: Workflow = {
  id: 'fixture-wf-demo',
  name: 'Demo',
  enabled: true,
  showInTray: true,
  showInRemote: false,
  trigger: { kind: 'manual', confirm: false },
  graph: {
    blocks: [
      {
        id: 'b1',
        scripts: [{ groupId: 'fixture-1-services', scriptId: 'install' }],
        x: 0,
        y: 0,
        requireAll: true,
      },
    ],
    edges: [{ from: 'trigger', to: 'b1' }],
  },
};
const DEMO_RUN: WorkflowRunRecord = {
  startedAt: 10,
  finishedAt: 20,
  durationMs: 10,
  result: 'error',
};
const FIXTURE_RUNS: Record<string, WorkflowRunRecord> = {
  'fixture-wf-demo': DEMO_RUN,
};

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
      store.setGroupsOverlay({ groups: fixtures(store) });

      expect(store.groupsOverlayActive()).toBe(true);
      expect(store.listGroups().map((g) => g.id)).toEqual([
        'fixture-1-services',
      ]);
      expect(store.getGroup('g-api')).toBeNull();
      expect(store.listWorkflows()).toEqual([]);
    });

    it('leaves the stored config untouched across on → edit → off', async () => {
      const store = await storeWithRealConfig();
      const before = harness.onDisk();
      store.setGroupsOverlay({ groups: fixtures(store) });

      // Every kind of write the config window can make.
      store.saveGroup({ ...rawGroup('g-new', 'new') });
      store.saveGroup({ ...rawGroup('g-api', 'api'), name: 'hijacked' });
      store.deleteGroup('fixture-1-services');
      store.reorderGroups(['g-new', 'g-api']);
      store.saveCommand('g-new', { id: 'x', name: 'x', command: 'echo x' });
      store.saveAction('g-new', { id: 'a', name: 'a', command: 'echo a' });
      store.savePreScript('g-new', { id: 'p', name: 'p', command: 'echo p' });
      store.saveWorkflow({
        id: 'w-test',
        name: 'Prueba',
        trigger: { kind: 'startup' },
        graph: {
          blocks: [
            {
              id: 's2',
              scripts: [{ groupId: 'g-new', scriptId: 'p' }],
              x: 0,
              y: 0,
            },
          ],
          edges: [],
        },
      });
      store.setGroupHiddenInTray('g-new', true);
      store.setGroupSilence('g-new', 'warn', true);

      expect(harness.onDisk()).toEqual(before);
      store.setGroupsOverlay(null);
      expect(harness.onDisk()).toEqual(before);
      expect(store.groupsOverlayActive()).toBe(false);
      expect(store.listGroups().map((g) => g.name)).toEqual(['api', 'web']);
      expect(
        store.getWorkflow('w-start')?.graph.blocks.map((b) => b.id),
      ).toEqual(['s1']);
    });

    it('keeps edits made while on in memory, on the overlay groups', async () => {
      const store = await storeWithRealConfig();
      store.setGroupsOverlay({ groups: fixtures(store) });

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
      store.setGroupsOverlay({ groups: fixtures(store) });

      const read = store.listGroups();
      if (read[0]) read[0].name = 'mutated';

      expect(store.listGroups()[0]?.name).toBe('Prueba 1 · Servicios');
    });

    it('exports the stored groups, never the overlay', async () => {
      const store = await storeWithRealConfig();
      store.setGroupsOverlay({ groups: fixtures(store) });

      const exported = JSON.stringify(store.exportConfig());

      expect(exported).toContain('g-api');
      expect(exported).not.toContain('fixture-');
    });

    it('refuses an import while it is on', async () => {
      const store = await storeWithRealConfig();
      const before = harness.onDisk();
      store.setGroupsOverlay({ groups: fixtures(store) });

      expect(() =>
        store.replaceConfig({ version: 3, groups: [], globalSettings: {} }),
      ).toThrow(/Modo grupos de prueba activo/);
      expect(harness.onDisk()).toEqual(before);
    });
  });

  describe('the workflows overlay', () => {
    function withWorkflows(store: Awaited<ReturnType<typeof harness.open>>) {
      store.setGroupsOverlay({
        groups: fixtures(store),
        workflows: [FIXTURE_WORKFLOW],
        workflowRuns: FIXTURE_RUNS,
      });
    }

    it('shows only the fixture workflows and their seeded runs while it is on', async () => {
      const store = await storeWithRealConfig();
      withWorkflows(store);

      expect(store.listWorkflows()).toEqual([FIXTURE_WORKFLOW]);
      expect(store.getWorkflow('w-start')).toBeNull();
      expect(store.getWorkflowRuns()).toEqual(FIXTURE_RUNS);
      expect(store.getScheduleLastRun('cmd:g-api:dev')).toBeNull();
    });

    it('brings back the real workflows, runs and schedule markers exactly, on → edit → off', async () => {
      const store = await storeWithRealConfig();
      const workflows = store.listWorkflows();
      const runs = store.getWorkflowRuns();
      const before = harness.onDisk();
      withWorkflows(store);

      // Every kind of workflow write the app can make while it is on.
      store.saveWorkflow({ ...FIXTURE_WORKFLOW, name: 'Editado' });
      store.createWorkflow('Nuevo', { kind: 'manual', confirm: true });
      store.setWorkflowEnabled('fixture-wf-demo', false);
      store.makeStartupWorkflow('fixture-wf-demo');
      store.recordWorkflowRun('fixture-wf-demo', {
        startedAt: 30,
        finishedAt: 40,
        durationMs: 10,
        result: 'success',
      });
      store.setScheduleLastRun('wf:fixture-wf-demo', '2026-10-19T00:00:00Z');
      store.deleteWorkflow('fixture-wf-demo');
      store.deleteWorkflow('w-start');

      expect(harness.onDisk()).toEqual(before);
      store.setGroupsOverlay(null);
      expect(harness.onDisk()).toEqual(before);
      expect(store.listWorkflows()).toEqual(workflows);
      expect(store.getWorkflowRuns()).toEqual(runs);
      expect(store.getScheduleLastRun('cmd:g-api:dev')).toBe(
        '2026-10-01T08:00:00.000Z',
      );
    });

    it('keeps runs recorded while on in memory, next to the seeded ones', async () => {
      const store = await storeWithRealConfig();
      withWorkflows(store);
      const run: WorkflowRunRecord = {
        startedAt: 50,
        finishedAt: 60,
        durationMs: 10,
        result: 'cancelled',
      };

      store.recordWorkflowRun('fixture-wf-other', run);

      expect(store.getWorkflowRuns()).toEqual({
        ...FIXTURE_RUNS,
        'fixture-wf-other': run,
      });
    });

    it('is gone after a restart: the app comes back on the real workflows', async () => {
      const store = await storeWithRealConfig();
      const workflows = store.listWorkflows();
      const runs = store.getWorkflowRuns();
      withWorkflows(store);
      store.recordWorkflowRun('fixture-wf-demo', DEMO_RUN);

      const restarted = await harness.open({ home: harness.home() });

      expect(restarted.groupsOverlayActive()).toBe(false);
      expect(restarted.listWorkflows()).toEqual(workflows);
      expect(restarted.getWorkflowRuns()).toEqual(runs);
    });
  });
});
