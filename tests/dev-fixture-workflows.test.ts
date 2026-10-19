import { describe, expect, it } from 'vitest';
import {
  buildFixtureGroups,
  type FixtureEnvironment,
} from '../src/dev/fixture-groups.js';
import {
  buildFixtureWorkflowRuns,
  buildFixtureWorkflows,
} from '../src/dev/fixture-workflows.js';
import { FIXTURE_SCRIPTS_GROUP_ID } from '../src/dev/fixture-scripts.js';
import {
  descendants,
  disconnectedBlocks,
  PIPELINE_TRIGGER,
} from '../src/pipeline-graph.js';
import { normalizeWorkflows, validateWorkflow } from '../src/workflows.js';
import type { Group, PreStepScriptRef, Workflow } from '../src/domain-types.js';

function env(overrides: Partial<FixtureEnvironment> = {}): FixtureEnvironment {
  return {
    platform: 'darwin',
    execPath: '/Applications/DevBar.app/Contents/MacOS/DevBar',
    tmpDir: '/tmp',
    repoPath: null,
    ...overrides,
  };
}

function resolvesIn(groups: readonly Group[]) {
  return (ref: PreStepScriptRef) =>
    groups.some(
      (group) =>
        group.id === ref.groupId &&
        group.preScripts.some((script) => script.id === ref.scriptId),
    );
}

function byName(workflows: readonly Workflow[], pattern: RegExp): Workflow {
  const found = workflows.find((w) => pattern.test(w.name));
  if (!found) throw new Error(`no fixture workflow matches ${pattern}`);
  return found;
}

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

describe('src/dev/fixture-workflows.ts', () => {
  describe('buildFixtureWorkflows', () => {
    it('makes enough workflows to page the list, all with fixture ids', () => {
      const workflows = buildFixtureWorkflows();
      expect(workflows.length).toBeGreaterThanOrEqual(22);
      const ids = workflows.map((w) => w.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^fixture-/);
      const names = workflows.map((w) => w.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('passes the same validation a save from the config window goes through', () => {
      const groups = buildFixtureGroups(env(), 1);
      const workflows = buildFixtureWorkflows();
      workflows.forEach((workflow, index) => {
        const others = workflows.slice(0, index);
        const result = validateWorkflow(workflow, {
          others,
          resolves: resolvesIn(groups),
        });
        expect(result, workflow.name).toEqual({ ok: true, workflow });
      });
      expect(normalizeWorkflows(workflows)).toEqual(workflows);
    });

    it('only references scripts of the fixture scripts group, whatever the copy count', () => {
      for (const repeat of [1, 3]) {
        const resolves = resolvesIn(buildFixtureGroups(env(), repeat));
        for (const workflow of buildFixtureWorkflows())
          for (const block of workflow.graph.blocks)
            for (const ref of block.scripts) {
              expect(ref.groupId).toBe(FIXTURE_SCRIPTS_GROUP_ID);
              expect(resolves(ref), `${workflow.name}: ${ref.scriptId}`).toBe(
                true,
              );
            }
      }
    });

    it('has exactly one startup workflow, and it is armed', () => {
      const startup = buildFixtureWorkflows().filter(
        (w) => w.trigger.kind === 'startup',
      );
      expect(startup).toHaveLength(1);
      expect(startup[0]?.enabled).toBe(true);
    });

    it('schedules nothing that fires constantly while the demo is on', () => {
      const scheduled = buildFixtureWorkflows().filter(
        (w) => w.trigger.kind === 'schedule',
      );
      const intervals = scheduled.flatMap((w) =>
        w.trigger.kind === 'schedule' && w.trigger.schedule.interval
          ? [{ workflow: w, interval: w.trigger.schedule.interval }]
          : [],
      );
      expect(
        scheduled.some(
          (w) =>
            w.trigger.kind === 'schedule' &&
            w.trigger.schedule.rules.some((rule) => rule.days.length === 5),
        ),
      ).toBe(true);
      expect(intervals).toContainEqual(
        expect.objectContaining({ interval: { every: 6, unit: 'hours' } }),
      );
      for (const { workflow, interval } of intervals)
        if (interval.unit === 'minutes' && interval.every < 60)
          expect(workflow.enabled, workflow.name).toBe(false);
      expect(
        intervals.some(
          ({ interval }) => interval.unit === 'minutes' && interval.every === 2,
        ),
      ).toBe(true);
    });

    it('covers every manual combination of confirmation and visibility', () => {
      const manual = buildFixtureWorkflows().filter(
        (w) => w.trigger.kind === 'manual',
      );
      const combos = new Set(
        manual.map(
          (w) =>
            `${w.trigger.kind === 'manual' && w.trigger.confirm}:${w.hidden}`,
        ),
      );
      for (const combo of ['true:false', 'false:false', 'false:true'])
        expect(combos.has(combo), combo).toBe(true);
      expect(buildFixtureWorkflows().some((w) => !w.enabled)).toBe(true);
    });

    it('draws every graph shape the canvas has to handle', () => {
      const workflows = buildFixtureWorkflows();
      const graphs = workflows.map((w) => w.graph);
      expect(graphs.some((g) => g.blocks.length === 0)).toBe(true);
      expect(graphs.some((g) => g.blocks.length === 1)).toBe(true);
      expect(graphs.some((g) => g.blocks.length >= 12)).toBe(true);
      const frames = graphs.flatMap((g) =>
        g.blocks.filter((b) => b.scripts.length > 1),
      );
      expect(new Set(frames.map((b) => b.requireAll))).toEqual(
        new Set([true, false]),
      );
      expect(graphs.some((g) => disconnectedBlocks(g).length > 0)).toBe(true);
      // A join: one block waiting on two sources.
      expect(
        graphs.some((g) =>
          g.blocks.some(
            (b) =>
              g.edges.filter(
                (e) => e.to === b.id && e.from !== PIPELINE_TRIGGER,
              ).length >= 2,
          ),
        ),
      ).toBe(true);
    });

    it('branches C→D→E and C→F→G off one block', () => {
      const { graph } = byName(buildFixtureWorkflows(), /ramas/i);
      const fork = graph.blocks.find(
        (b) => graph.edges.filter((e) => e.from === b.id).length === 2,
      );
      expect(fork).toBeDefined();
      expect(descendants(graph, fork?.id ?? '')).toHaveLength(4);
    });

    it('puts a failing script ahead of blocks it would skip', () => {
      const { graph } = byName(buildFixtureWorkflows(), /rama que falla/i);
      const failing = graph.blocks.find((b) =>
        b.scripts.some((s) => s.scriptId === 'falla'),
      );
      expect(descendants(graph, failing?.id ?? '').length).toBeGreaterThan(0);
    });

    it('lays every graph out instead of stacking it at the origin', () => {
      for (const workflow of buildFixtureWorkflows()) {
        const spots = workflow.graph.blocks.map((b) => `${b.x},${b.y}`);
        expect(new Set(spots).size, workflow.name).toBe(spots.length);
        for (const block of workflow.graph.blocks)
          expect(block.x, workflow.name).toBeGreaterThan(0);
      }
    });
  });

  describe('buildFixtureWorkflowRuns', () => {
    it('seeds a last run of every result for existing workflows, in the past', () => {
      const ids = new Set(buildFixtureWorkflows().map((w) => w.id));
      const runs = buildFixtureWorkflowRuns(NOW);
      expect(new Set(Object.values(runs).map((r) => r.result))).toEqual(
        new Set(['success', 'warning', 'error', 'cancelled']),
      );
      for (const [id, run] of Object.entries(runs)) {
        expect(ids.has(id)).toBe(true);
        expect(run.finishedAt).toBeLessThan(NOW);
        expect(run.finishedAt - run.startedAt).toBe(run.durationMs);
      }
      // …and leaves most of them never run.
      expect(Object.keys(runs).length).toBeLessThan(ids.size);
    });
  });
});
