import { describe, expect, it } from 'vitest';
import {
  STARTUP_WORKFLOW_NAME,
  createWorkflow,
  makeStartup,
  normalizeWorkflows,
  pruneWorkflowRefs,
  startupWorkflow,
  validateWorkflow,
  workflowsFromPipeline,
} from '../src/workflows.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { Workflow, WorkflowTrigger } from '../src/domain-types.js';
import { block, graph, ref } from './helpers/pipeline.js';

/**
 * `src/workflows.ts` — the rules every workflow list obeys: at most one
 * startup workflow, a script once per workflow, triggers read leniently from
 * the store and strictly from a renderer.
 */

const MANUAL: WorkflowTrigger = { kind: 'manual', confirm: false };

function workflow(
  id: string,
  trigger: WorkflowTrigger = MANUAL,
  extra: Partial<Workflow> = {},
): Workflow {
  return {
    id,
    name: id,
    enabled: true,
    showInTray: true,
    showInRemote: false,
    trigger,
    graph: graph(['A'], ['trigger>A']),
    ...extra,
  };
}

describe('src/workflows.ts', () => {
  describe('normalizeWorkflows', () => {
    it('reads anything that is not a list as no workflows', () => {
      expect(normalizeWorkflows(undefined)).toEqual([]);
      expect(normalizeWorkflows({})).toEqual([]);
    });

    it('keeps a well-formed list as it is', () => {
      const list = [
        workflow('a', { kind: 'startup' }),
        workflow('b', {
          kind: 'schedule',
          schedule: {
            rules: [{ time: '23:30', days: [1, 2] }],
            interval: { every: 2, unit: 'hours' },
          },
        }),
        workflow('c'),
      ];
      expect(normalizeWorkflows(structuredClone(list))).toEqual(list);
    });

    it('defaults a missing name, flag and trigger', () => {
      const [only] = normalizeWorkflows([{ id: 'x' }]);
      expect(only).toMatchObject({
        id: 'x',
        name: 'Workflow',
        enabled: true,
        trigger: MANUAL,
        graph: { blocks: [], edges: [] },
      });
    });

    it('keeps only the first startup workflow; the rest become manual', () => {
      const list = normalizeWorkflows([
        workflow('a', { kind: 'startup' }),
        workflow('b', { kind: 'startup' }),
      ]);
      expect(list.map((w) => w.trigger.kind)).toEqual(['startup', 'manual']);
    });

    it('re-mints a repeated id', () => {
      const list = normalizeWorkflows([workflow('a'), workflow('a')]);
      expect(new Set(list.map((w) => w.id)).size).toBe(2);
    });

    it('clamps a schedule interval into a sane range', () => {
      const [only] = normalizeWorkflows([
        {
          id: 'a',
          trigger: {
            kind: 'schedule',
            schedule: { rules: [], interval: { every: 0, unit: 'weeks' } },
          },
        },
      ]);
      expect(only?.trigger).toEqual({
        kind: 'schedule',
        schedule: { rules: [], interval: { every: 1, unit: 'minutes' } },
      });
    });
  });

  describe('where a workflow shows (showInTray / showInRemote)', () => {
    it('moves the flags off a legacy manual trigger onto the workflow', () => {
      const [only] = normalizeWorkflows([
        {
          id: 'm',
          trigger: {
            kind: 'manual',
            showInTray: false,
            showInRemote: true,
            confirm: true,
          },
        },
      ]);
      expect(only).toMatchObject({
        showInTray: false,
        showInRemote: true,
        trigger: { kind: 'manual', confirm: true },
      });
      expect(only?.trigger).not.toHaveProperty('showInTray');
    });

    it('defaults by trigger: startup on the phone, the rest only in the tray', () => {
      const list = normalizeWorkflows([
        { id: 's', trigger: { kind: 'startup' } },
        { id: 'p', trigger: { kind: 'schedule', schedule: {} } },
        { id: 'm', trigger: { kind: 'manual' } },
      ]);
      expect(list.map((w) => [w.id, w.showInTray, w.showInRemote])).toEqual([
        ['s', true, true],
        ['p', true, false],
        ['m', true, false],
      ]);
    });

    it('keeps the flags stored on the workflow over a legacy trigger', () => {
      const [only] = normalizeWorkflows([
        {
          id: 's',
          showInTray: false,
          showInRemote: false,
          trigger: { kind: 'startup' },
        },
      ]);
      expect(only).toMatchObject({ showInTray: false, showInRemote: false });
    });

    it('migrates a legacy manual trigger in what a backup sends', () => {
      const result = validateWorkflow(
        {
          id: 'm',
          name: 'M',
          trigger: {
            kind: 'manual',
            showInTray: false,
            showInRemote: true,
            confirm: false,
          },
          graph: { blocks: [], edges: [] },
        },
        { others: [] },
      );
      expect(result).toMatchObject({
        ok: true,
        workflow: { showInTray: false, showInRemote: true, trigger: MANUAL },
      });
    });
  });

  describe('startupWorkflow / makeStartup', () => {
    it('finds the startup workflow, or null', () => {
      expect(startupWorkflow([workflow('a')])).toBeNull();
      expect(
        startupWorkflow([workflow('a'), workflow('b', { kind: 'startup' })])
          ?.id,
      ).toBe('b');
    });

    it('moves the startup trigger, leaving the previous one manual with its own visibility', () => {
      const list = makeStartup(
        [
          workflow('a', { kind: 'startup' }, { showInTray: false }),
          workflow('b'),
        ],
        'b',
      );
      expect(list.map((w) => [w.id, w.trigger, w.showInTray])).toEqual([
        ['a', MANUAL, false],
        ['b', { kind: 'startup' }, true],
      ]);
    });

    it('is a no-op for an unknown id', () => {
      const list = [workflow('a', { kind: 'startup' })];
      expect(makeStartup(list, 'nope')).toEqual(list);
    });
  });

  describe('createWorkflow', () => {
    it('starts enabled with an empty graph', () => {
      const created = createWorkflow(' Backup ', MANUAL, () => 'id1');
      expect(created).toEqual({
        id: 'id1',
        name: 'Backup',
        enabled: true,
        showInTray: true,
        showInRemote: false,
        trigger: MANUAL,
        graph: { blocks: [], edges: [] },
      });
    });

    it('shows a new startup workflow on the phone, a scheduled one only in the tray', () => {
      expect(createWorkflow('a', { kind: 'startup' }, () => 'a')).toMatchObject(
        { showInTray: true, showInRemote: true },
      );
      expect(
        createWorkflow(
          'b',
          { kind: 'schedule', schedule: { rules: [], interval: null } },
          () => 'b',
        ),
      ).toMatchObject({ showInTray: true, showInRemote: false });
    });
  });

  describe('workflowsFromPipeline', () => {
    it('turns a pipeline into the startup workflow «Arranque»', () => {
      const pipeline = graph(['A'], ['trigger>A']);
      expect(workflowsFromPipeline(pipeline, false, () => 'w')).toEqual([
        {
          id: 'w',
          name: STARTUP_WORKFLOW_NAME,
          enabled: false,
          showInTray: true,
          showInRemote: true,
          trigger: { kind: 'startup' },
          graph: pipeline,
        },
      ]);
    });

    it('creates nothing for an empty pipeline', () => {
      expect(workflowsFromPipeline({ blocks: [], edges: [] }, true)).toEqual(
        [],
      );
    });
  });

  describe('validateWorkflow', () => {
    it('accepts a valid workflow', () => {
      const candidate = workflow('a');
      expect(validateWorkflow(candidate, { others: [] })).toEqual({
        ok: true,
        workflow: candidate,
      });
    });

    it('refuses a blank name', () => {
      expect(
        validateWorkflow({ ...workflow('a'), name: '  ' }, { others: [] }),
      ).toEqual({ ok: false, error: 'El workflow necesita un nombre' });
    });

    it('refuses an unknown trigger', () => {
      expect(
        validateWorkflow(
          { ...workflow('a'), trigger: { kind: 'cron' } },
          { others: [] },
        ),
      ).toEqual({ ok: false, error: 'Disparador desconocido' });
    });

    it('refuses a second startup workflow', () => {
      expect(
        validateWorkflow(workflow('b', { kind: 'startup' }), {
          others: [workflow('a', { kind: 'startup' })],
        }),
      ).toEqual({ ok: false, error: 'Ya hay un workflow de arranque' });
    });

    it('lets the startup workflow itself be saved again', () => {
      const startup = workflow('a', { kind: 'startup' });
      expect(validateWorkflow(startup, { others: [startup] }).ok).toBe(true);
    });

    it('refuses a script placed twice in the same workflow', () => {
      const twice = {
        ...workflow('a'),
        graph: graph([block('A', ['x']), block('B', ['x'])], ['trigger>A']),
      };
      expect(validateWorkflow(twice, { others: [] })).toEqual({
        ok: false,
        error: 'Un script aparece en más de un bloque',
      });
    });

    it('refuses a ref the caller cannot resolve', () => {
      expect(
        validateWorkflow(workflow('a'), { others: [], resolves: () => false })
          .ok,
      ).toBe(false);
    });
  });

  describe('pruneWorkflowRefs', () => {
    it('drops refs to scripts that no longer exist, in every workflow', () => {
      const groups = [
        normalizeGroup({
          id: 'g',
          preScripts: [{ id: 'A', name: 'A', command: 'true' }],
        }),
      ];
      const list = [
        {
          ...workflow('a'),
          graph: graph(['A', 'B'], ['trigger>A', 'A>B']),
        },
      ];
      const [pruned] = pruneWorkflowRefs(list, groups);
      expect(pruned?.graph.blocks.map((b) => b.id)).toEqual(['A']);
      expect(ref('A')).toEqual(pruned?.graph.blocks[0]?.scripts[0]);
    });
  });
});
