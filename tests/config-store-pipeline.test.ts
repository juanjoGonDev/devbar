import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/config-store/pipeline-store.ts` — the global ordered pre-script steps,
 * the per-group script definitions they point at, and the placement of one
 * into the other.
 *
 * The referential-integrity pass matters most here: a step holds only
 * {groupId, scriptId} references, so every write has to re-derive them
 * against the groups that actually exist, or the pipeline ends up trying to
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

/** A store holding one group with two scripts and one empty step. */
async function storeWithPipeline(): Promise<ConfigStoreModule> {
  const store = await harness.open();
  store.saveGroup(groupWithScripts('api', ['setup', 'seed']));
  store.savePreStep({ id: 'step1', mode: 'serial', scripts: [] });
  return store;
}

describe('src/config-store/pipeline-store.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    harness.cleanup();
  });

  describe('steps', () => {
    it('starts with no steps at all', async () => {
      const store = await harness.open();

      expect(store.getPreSteps()).toEqual([]);
    });

    it('appends a new step and hands back what it stored', async () => {
      const store = await harness.open();

      const saved = store.savePreStep({ id: 'step1', mode: 'serial' });

      expect(saved).toEqual({ id: 'step1', mode: 'serial', scripts: [] });
      expect(store.getPreSteps()).toHaveLength(1);
    });

    it('defaults an unrecognised mode to parallel', async () => {
      const store = await harness.open();

      expect(store.savePreStep({ id: 'step1', mode: 'whenever' }).mode).toBe(
        'parallel',
      );
    });

    it('replaces a step with the same id rather than duplicating it', async () => {
      const store = await harness.open();
      store.savePreStep({ id: 'step1', mode: 'serial' });

      store.savePreStep({ id: 'step1', mode: 'parallel' });

      const steps = store.getPreSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]?.mode).toBe('parallel');
    });

    it('deletes one step and keeps the others', async () => {
      const store = await harness.open();
      store.savePreStep({ id: 'step1', mode: 'serial' });
      store.savePreStep({ id: 'step2', mode: 'serial' });

      store.deletePreStep('step1');

      expect(store.getPreSteps().map((step) => step.id)).toEqual(['step2']);
    });

    it('ignores a delete for a step that is not there', async () => {
      const store = await harness.open();
      store.savePreStep({ id: 'step1', mode: 'serial' });

      store.deletePreStep('nope');

      expect(store.getPreSteps()).toHaveLength(1);
    });

    it('reorders the steps and persists the new order', async () => {
      const store = await harness.open();
      for (const id of ['a', 'b', 'c'])
        store.savePreStep({ id, mode: 'serial' });

      const sorted = store.reorderPreSteps(['c', 'a']);

      expect(sorted.map((step) => step.id)).toEqual(['c', 'a', 'b']);
      expect(store.getPreSteps().map((step) => step.id)).toEqual([
        'c',
        'a',
        'b',
      ]);
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

  describe('placing a script into a step', () => {
    it('appends the reference to the step', async () => {
      const store = await harness.open();
      store.saveGroup(groupWithScripts('api', ['setup', 'seed']));
      store.savePreStep({ id: 'step1', mode: 'serial', scripts: [] });

      store.assignScriptToStep('step1', 'g-api', 'setup');
      const steps = store.assignScriptToStep('step1', 'g-api', 'seed');

      expect(steps[0]?.scripts).toEqual([
        { groupId: 'g-api', scriptId: 'setup' },
        { groupId: 'g-api', scriptId: 'seed' },
      ]);
      expect(store.getPreSteps()[0]?.scripts).toHaveLength(2);
    });

    it('honours an explicit position', async () => {
      const store = await storeWithPipeline();
      store.assignScriptToStep('step1', 'g-api', 'setup');

      store.assignScriptToStep('step1', 'g-api', 'seed', 0);

      expect(
        store.getPreSteps()[0]?.scripts.map((ref) => ref.scriptId),
      ).toEqual(['seed', 'setup']);
    });

    it('moves a reference between steps instead of leaving two copies', async () => {
      const store = await storeWithPipeline();
      store.savePreStep({ id: 'step2', mode: 'serial', scripts: [] });
      store.assignScriptToStep('step1', 'g-api', 'setup');

      store.assignScriptToStep('step2', 'g-api', 'setup');

      const steps = store.getPreSteps();
      expect(steps[0]?.scripts).toEqual([]);
      expect(steps[1]?.scripts).toEqual([
        { groupId: 'g-api', scriptId: 'setup' },
      ]);
    });

    it('takes the reference back out of its step', async () => {
      const store = await storeWithPipeline();
      store.assignScriptToStep('step1', 'g-api', 'setup');
      store.assignScriptToStep('step1', 'g-api', 'seed');

      const steps = store.unassignScriptFromStep('step1', 'g-api', 'setup');

      expect(steps[0]?.scripts).toEqual([
        { groupId: 'g-api', scriptId: 'seed' },
      ]);
      expect(store.getPreSteps()[0]?.scripts).toHaveLength(1);
    });
  });

  describe('referential integrity', () => {
    it('drops a reference to a script that has just been deleted', async () => {
      const store = await storeWithPipeline();
      store.assignScriptToStep('step1', 'g-api', 'setup');
      store.assignScriptToStep('step1', 'g-api', 'seed');

      store.deletePreScript('g-api', 'setup');

      // The step survives as an ordering slot; only the dangling ref goes.
      const steps = store.getPreSteps();
      expect(steps).toHaveLength(1);
      expect(steps[0]?.scripts).toEqual([
        { groupId: 'g-api', scriptId: 'seed' },
      ]);
    });

    it('drops every reference into a group that has just been deleted', async () => {
      const store = await storeWithPipeline();
      store.assignScriptToStep('step1', 'g-api', 'setup');

      store.deleteGroup('g-api');

      expect(store.getPreSteps()[0]?.scripts).toEqual([]);
    });

    it('never stores a reference to a script that does not exist', async () => {
      const store = await storeWithPipeline();

      store.assignScriptToStep('step1', 'g-api', 'ghost');

      expect(store.getPreSteps()[0]?.scripts).toEqual([]);
    });

    it('keeps the references of the groups that stayed', async () => {
      const store = await storeWithPipeline();
      store.saveGroup(groupWithScripts('web', ['build']));
      store.assignScriptToStep('step1', 'g-api', 'setup');
      store.assignScriptToStep('step1', 'g-web', 'build');

      store.deleteGroup('g-api');

      expect(store.getPreSteps()[0]?.scripts).toEqual([
        { groupId: 'g-web', scriptId: 'build' },
      ]);
    });

    it('hands the pipeline back to the next session unchanged', async () => {
      const first = await storeWithPipeline();
      first.assignScriptToStep('step1', 'g-api', 'setup');

      const second = await harness.open({ home: harness.home() });

      expect(second.getPreSteps()).toEqual([
        {
          id: 'step1',
          mode: 'serial',
          scripts: [{ groupId: 'g-api', scriptId: 'setup' }],
        },
      ]);
    });
  });
});
