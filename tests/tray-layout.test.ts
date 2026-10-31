import { describe, expect, it } from 'vitest';

import {
  foldHidden,
  trayGroupLayout,
  trayWorkflowLayout,
  workflowListed,
} from '../src/tray-layout.js';
import type { WorkflowEntry } from '../src/ipc-contract.js';
import type { Workflow, WorkflowTrigger } from '../src/domain-types.js';

/**
 * The one rule both the tray and a linked phone follow for what is hidden
 * from them — groups and workflows alike: listed after the rest behind a
 * fold, or not listed at all.
 */

const state = (name: string, hiddenInTray = false) => ({
  name,
  group: { hiddenInTray },
});

const MANUAL: WorkflowTrigger = { kind: 'manual', confirm: false };
const SCHEDULE: WorkflowTrigger = {
  kind: 'schedule',
  schedule: { rules: [{ time: '23:30', days: [] }], interval: null },
};
const RUNNING = { runId: 1, doneScripts: 3, totalScripts: 8, startedAt: 0 };

function entry(
  id: string,
  trigger: WorkflowTrigger = MANUAL,
  extra: Partial<WorkflowEntry> = {},
  workflow: Partial<Workflow> = {},
): WorkflowEntry {
  return {
    workflow: {
      id,
      name: id,
      enabled: true,
      hidden: false,
      trigger,
      graph: { blocks: [], edges: [] },
      ...workflow,
    },
    lastRun: null,
    nextRunAt: null,
    scriptCount: 2,
    running: null,
    ...extra,
  };
}

const ids = (list: readonly WorkflowEntry[]): string[] =>
  list.map((e) => e.workflow.id);

describe('src/tray-layout.ts', () => {
  describe('foldHidden', () => {
    it('splits any list by a hidden predicate, keeping the order', () => {
      const layout = foldHidden([1, 2, 3, 4], (n) => n % 2 === 0, true);
      expect(layout).toEqual({ shown: [1, 3], folded: [2, 4] });
    });

    it('lists nothing hidden with the fold off', () => {
      expect(foldHidden([1, 2], (n) => n === 2, false)).toEqual({
        shown: [1],
        folded: [],
      });
    });
  });

  describe('trayGroupLayout', () => {
    it('keeps the visible groups in order and folds the hidden ones', () => {
      const layout = trayGroupLayout(
        [state('api'), state('web', true), state('db'), state('mq', true)],
        true,
      );
      expect(layout.shown.map((s) => s.name)).toEqual(['api', 'db']);
      expect(layout.folded.map((s) => s.name)).toEqual(['web', 'mq']);
    });

    it('drops the hidden groups when the fold is turned off', () => {
      const layout = trayGroupLayout([state('api'), state('web', true)], false);
      expect(layout.shown.map((s) => s.name)).toEqual(['api']);
      expect(layout.folded).toEqual([]);
    });
  });

  describe('trayWorkflowLayout', () => {
    it('lists the running ones first, then startup, manual and scheduled', () => {
      const { shown } = trayWorkflowLayout(
        [
          entry('cron', SCHEDULE),
          entry('manual'),
          entry('start', { kind: 'startup' }),
          entry('busy', MANUAL, { running: RUNNING }),
        ],
        false,
      );
      expect(ids(shown)).toEqual(['busy', 'start', 'manual', 'cron']);
    });

    it('leaves out what is off or has nothing to run', () => {
      const layout = trayWorkflowLayout(
        [
          entry('off', MANUAL, {}, { enabled: false }),
          entry('empty', MANUAL, { scriptCount: 0 }),
          entry('cron-off', SCHEDULE, {}, { enabled: false }),
          entry('start-off', { kind: 'startup' }, {}, { enabled: false }),
          entry('shown'),
        ],
        true,
      );
      expect(ids(layout.shown)).toEqual(['shown']);
      expect(layout.folded).toEqual([]);
    });

    it('folds the hidden ones (whatever their trigger) in the same order', () => {
      const layout = trayWorkflowLayout(
        [
          entry('cron', SCHEDULE, {}, { hidden: true }),
          entry('desk', MANUAL, {}, { hidden: true }),
          entry('start', { kind: 'startup' }, {}, { hidden: true }),
          entry('shown'),
        ],
        true,
      );
      expect(ids(layout.shown)).toEqual(['shown']);
      expect(ids(layout.folded)).toEqual(['start', 'desk', 'cron']);
    });

    it('drops the hidden ones with the fold off', () => {
      const layout = trayWorkflowLayout(
        [entry('desk', MANUAL, {}, { hidden: true }), entry('shown')],
        false,
      );
      expect(ids(layout.shown)).toEqual(['shown']);
      expect(layout.folded).toEqual([]);
    });

    it('always lists a running workflow, hidden or off, outside the fold', () => {
      const layout = trayWorkflowLayout(
        [
          entry('desk', MANUAL, { running: RUNNING }, { hidden: true }),
          entry('off', MANUAL, { running: RUNNING }, { enabled: false }),
        ],
        false,
      );
      expect(ids(layout.shown)).toEqual(['desk', 'off']);
      expect(layout.folded).toEqual([]);
    });
  });

  describe('workflowListed', () => {
    it('says whether the tray and the phone list a workflow at all', () => {
      expect(workflowListed(entry('a'), false)).toBe(true);
      expect(
        workflowListed(entry('a', MANUAL, {}, { hidden: true }), false),
      ).toBe(false);
      expect(
        workflowListed(entry('a', MANUAL, {}, { hidden: true }), true),
      ).toBe(true);
      expect(
        workflowListed(entry('a', MANUAL, {}, { enabled: false }), true),
      ).toBe(false);
      expect(
        workflowListed(
          entry('a', MANUAL, { running: RUNNING }, { hidden: true }),
          false,
        ),
      ).toBe(true);
    });
  });
});
