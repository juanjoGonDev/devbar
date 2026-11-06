import { describe, expect, it } from 'vitest';
import {
  createFixtureMode,
  isFixtureProcess,
  type FixtureHost,
  type FixtureOverlay,
} from '../src/dev/fixture-mode.js';
import { buildFixtureWorkflows } from '../src/dev/fixture-workflows.js';

const WORKFLOWS = buildFixtureWorkflows().length;

function harness(running: string[] = [], runningWorkflows: string[] = []) {
  const calls: string[] = [];
  const stopping: (() => void)[] = [];
  let overlay: FixtureOverlay | null = null;
  const liveWorkflows = new Set(runningWorkflows);
  let failStops = false;
  let deferStops = false;
  const live = new Set(running);
  const host: FixtureHost = {
    environment: () => ({
      platform: 'linux',
      execPath: '/opt/DevBar/devbar',
      tmpDir: '/tmp',
      repoPath: null,
    }),
    setOverlay: (next) => {
      overlay = next;
      calls.push(
        next
          ? `overlay:${next.groups.length}/${next.workflows.length}`
          : 'overlay:off',
      );
    },
    runningWorkflowIds: () => [...liveWorkflows],
    stopWorkflow: (id) => {
      calls.push(`stopWorkflow:${id}`);
      liveWorkflows.delete(id);
      return Promise.resolve();
    },
    processIds: () => [...live],
    stop: (id) => {
      calls.push(`stop:${id}`);
      if (failStops) return Promise.resolve({ ok: false, error: 'stuck' });
      const done = () => {
        live.delete(id);
        calls.push(`stopped:${id}`);
      };
      if (!deferStops) {
        done();
        return Promise.resolve({ ok: true });
      }
      return new Promise((resolve) => {
        stopping.push(() => {
          done();
          resolve({ ok: true });
        });
      });
    },
    removeState: (id) => calls.push(`remove:${id}`),
    refresh: () => calls.push('refresh'),
  };
  return {
    mode: createFixtureMode(host),
    calls,
    live,
    liveWorkflows,
    overlay: () => overlay,
    failStops: () => {
      failStops = true;
    },
    deferStops: () => {
      deferStops = true;
    },
    finishStops: () => {
      for (const finish of stopping.splice(0)) finish();
    },
  };
}

describe('src/dev/fixture-mode.ts', () => {
  describe('isFixtureProcess', () => {
    it('recognises the commands, actions and pre-scripts of a fixture group', () => {
      expect(isFixtureProcess('cmd:fixture-1-services:tick')).toBe(true);
      expect(isFixtureProcess('act:fixture-2-services:ok')).toBe(true);
      expect(isFixtureProcess('pre:fixture-1-repo:x')).toBe(true);
    });

    it('never claims a real group or the pipeline aggregator', () => {
      expect(isFixtureProcess('cmd:g-api:dev')).toBe(false);
      expect(isFixtureProcess('cmd:my-fixture-1:dev')).toBe(false);
      expect(isFixtureProcess('pre-pipeline:fixture-1')).toBe(false);
    });
  });

  describe('enable', () => {
    it('shows N copies of the fixture set and repaints every window', async () => {
      const h = harness();
      const result = await h.mode.enable(2);
      expect(result).toMatchObject({ ok: true, active: true, repeat: 2 });
      expect(h.overlay()?.groups.length).toBe(7);
      expect(h.calls).toEqual([`overlay:7/${WORKFLOWS}`, 'refresh']);
      expect(h.mode.status()).toEqual({ active: true, repeat: 2 });
    });

    it('swaps in the fixture workflows with their seeded runs, and runs none of them', async () => {
      const h = harness();
      await h.mode.enable(1);
      const overlay = h.overlay();
      expect(overlay?.workflows).toEqual(buildFixtureWorkflows());
      const runIds = Object.keys(overlay?.workflowRuns ?? {});
      expect(runIds.length).toBeGreaterThan(0);
      for (const id of runIds) expect(id).toMatch(/^fixture-wf-/);
      expect(h.calls.some((c) => c.startsWith('stopWorkflow'))).toBe(false);
    });

    it('clamps the repeat count to the 1–20 the panel allows', async () => {
      const h = harness();
      expect((await h.mode.enable(50)).repeat).toBe(20);
    });

    it('stops the old copies before swapping in a different count', async () => {
      const h = harness();
      await h.mode.enable(1);
      h.live.add('cmd:fixture-1-services:tick');
      h.calls.length = 0;
      await h.mode.enable(3);
      expect(h.calls).toEqual([
        'stop:cmd:fixture-1-services:tick',
        'stopped:cmd:fixture-1-services:tick',
        'remove:cmd:fixture-1-services:tick',
        `overlay:10/${WORKFLOWS}`,
        'refresh',
      ]);
    });
  });

  describe('disable', () => {
    it('stops every fixture process, then restores the real groups', async () => {
      const h = harness(['cmd:g-api:dev']);
      await h.mode.enable(1);
      h.live.add('cmd:fixture-1-services:tick');
      h.live.add('act:fixture-1-services:slow');
      h.calls.length = 0;

      const result = await h.mode.disable();

      expect(result).toMatchObject({ ok: true, active: false });
      expect(h.calls).toEqual([
        'stop:cmd:fixture-1-services:tick',
        'stopped:cmd:fixture-1-services:tick',
        'stop:act:fixture-1-services:slow',
        'stopped:act:fixture-1-services:slow',
        'remove:cmd:fixture-1-services:tick',
        'remove:act:fixture-1-services:slow',
        'overlay:off',
        'refresh',
      ]);
    });

    it('cancels the demo runs and waits for them before stopping processes and restoring', async () => {
      const h = harness([], ['fixture-wf-largo', 'w-user-created-in-demo']);
      await h.mode.enable(1);
      h.live.add('pre:fixture-scripts:lento-40');
      h.calls.length = 0;

      await h.mode.disable();

      expect(h.calls).toEqual([
        'stopWorkflow:fixture-wf-largo',
        'stopWorkflow:w-user-created-in-demo',
        'stop:pre:fixture-scripts:lento-40',
        'stopped:pre:fixture-scripts:lento-40',
        'remove:pre:fixture-scripts:lento-40',
        'overlay:off',
        'refresh',
      ]);
      expect([...h.liveWorkflows]).toEqual([]);
    });

    it('never touches the processes of the real groups', async () => {
      const h = harness(['cmd:g-api:dev', 'act:g-web:deploy']);
      await h.mode.enable(1);
      await h.mode.disable();
      expect(h.calls.filter((c) => c.includes('g-'))).toEqual([]);
      expect([...h.live]).toEqual(['cmd:g-api:dev', 'act:g-web:deploy']);
    });

    it('waits for the stops to finish before dropping the overlay', async () => {
      const h = harness();
      await h.mode.enable(1);
      h.live.add('cmd:fixture-1-services:tick');
      h.deferStops();
      h.calls.length = 0;

      const pending = h.mode.disable();
      await Promise.resolve();
      expect(h.calls).toEqual(['stop:cmd:fixture-1-services:tick']);
      h.finishStops();
      await pending;
      expect(h.calls.at(-2)).toBe('overlay:off');
    });

    it('keeps the test groups on screen when a stop fails', async () => {
      // Dropping them would leave a running child no window can reach.
      const h = harness();
      await h.mode.enable(1);
      h.live.add('cmd:fixture-1-services:tick');
      h.failStops();

      const result = await h.mode.disable();

      expect(result).toMatchObject({ ok: false, active: true });
      expect(result.error).toContain('cmd:fixture-1-services:tick');
      expect(h.calls).not.toContain('overlay:off');
      expect(h.mode.status().active).toBe(true);
    });

    it('does nothing when the test groups are not shown', async () => {
      const h = harness(['cmd:g-api:dev']);
      expect(await h.mode.disable()).toMatchObject({ ok: true, active: false });
      expect(h.calls).toEqual([]);
    });
  });
});
