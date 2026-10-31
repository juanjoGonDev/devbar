import { describe, expect, it } from 'vitest';
import {
  formatWhen,
  workflowSubtitle,
} from '../renderer/tray/workflow-format.js';
import type { WorkflowEntry } from '../src/ipc-contract.js';
import type { Workflow, WorkflowTrigger } from '../src/domain-types.js';

/**
 * `renderer/tray/workflow-format.ts` — the one-line subtitle under each of
 * the tray's workflows (which ones it lists is src/tray-layout.ts).
 */

// 2026-01-05 is a Monday.
const NOW = new Date(2026, 0, 5, 15, 0).getTime();
const at = (d: number, h: number, mi: number): number =>
  new Date(2026, 0, d, h, mi).getTime();

const MANUAL: WorkflowTrigger = { kind: 'manual', confirm: false };
const SCHEDULE: WorkflowTrigger = {
  kind: 'schedule',
  schedule: { rules: [{ time: '23:30', days: [] }], interval: null },
};

function entry(
  id: string,
  trigger: WorkflowTrigger,
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

describe('renderer/tray/workflow-format.ts', () => {
  describe('formatWhen', () => {
    it('says today, yesterday, a weekday or a date', () => {
      expect(formatWhen(at(5, 23, 30), NOW)).toBe('hoy 23:30');
      expect(formatWhen(at(4, 9, 5), NOW)).toBe('ayer 09:05');
      expect(formatWhen(at(6, 8, 0), NOW)).toBe('mañana 08:00');
      expect(formatWhen(at(1, 17, 12), NOW)).toBe('jue 17:12');
      expect(formatWhen(new Date(2025, 11, 20, 10, 0).getTime(), NOW)).toBe(
        '20/12 10:00',
      );
    });
  });

  describe('workflowSubtitle', () => {
    it('describes a manual workflow by its last run', () => {
      expect(workflowSubtitle(entry('m', MANUAL), NOW)).toBe('Manual');
      expect(
        workflowSubtitle(
          entry('m', MANUAL, {
            lastRun: {
              startedAt: 0,
              finishedAt: at(5, 9, 0),
              durationMs: 1,
              result: 'warning',
            },
          }),
          NOW,
        ),
      ).toBe('Manual · hoy 09:00 · con avisos');
    });

    it('describes a scheduled one by its next run, or by a failed last run', () => {
      expect(
        workflowSubtitle(
          entry('c', SCHEDULE, { nextRunAt: at(5, 23, 30) }),
          NOW,
        ),
      ).toBe('Programado · próxima hoy 23:30');
      expect(
        workflowSubtitle(
          entry('c', SCHEDULE, {
            nextRunAt: at(5, 23, 30),
            lastRun: {
              startedAt: 0,
              finishedAt: at(5, 14, 0),
              durationMs: 1,
              result: 'error',
            },
          }),
          NOW,
        ),
      ).toBe('Programado · falló hoy 14:00');
    });

    it('describes the startup workflow', () => {
      expect(workflowSubtitle(entry('s', { kind: 'startup' }), NOW)).toBe(
        'Al arrancar',
      );
      expect(
        workflowSubtitle(
          entry('s', { kind: 'startup' }, {}, { enabled: false }),
          NOW,
        ),
      ).toBe('Al arrancar · desactivado');
    });
  });
});
