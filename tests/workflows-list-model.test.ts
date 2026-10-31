import { describe, expect, it } from 'vitest';
import {
  filterCounts,
  formatAgo,
  formatClock,
  formatDuration,
  formatPreciseDuration,
  lastRunText,
  listWorkflows,
  nextRunText,
  paginate,
  runningCount,
  scheduleSummary,
  scriptsLine,
  workflowStatus,
} from '../renderer/workflows/list-model.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { WorkflowEntry } from '../src/ipc-contract.js';
import type {
  Pipeline,
  Workflow,
  WorkflowTrigger,
} from '../src/domain-types.js';

/**
 * `renderer/workflows/list-model.ts` — what the Workflows list shows, in which
 * order and page, and every piece of wording on a row.
 */

// 2026-01-05 is a Monday.
const NOW = new Date(2026, 0, 5, 15, 0).getTime();
const at = (d: number, h: number, mi: number, s = 0): number =>
  new Date(2026, 0, d, h, mi, s).getTime();

const MANUAL: WorkflowTrigger = {
  kind: 'manual',
  confirm: false,
};
const STARTUP: WorkflowTrigger = { kind: 'startup' };
const SCHEDULE: WorkflowTrigger = {
  kind: 'schedule',
  schedule: {
    rules: [{ time: '23:30', days: [1, 2, 3, 4, 5] }],
    interval: null,
  },
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
    scriptCount: 1,
    running: null,
    ...extra,
  };
}

const ids = (entries: WorkflowEntry[]): string[] =>
  entries.map((e) => e.workflow.id);

describe('renderer/workflows/list-model.ts', () => {
  describe('listWorkflows', () => {
    const entries = [
      entry('Backup', SCHEDULE),
      entry('Demo', MANUAL),
      entry('Arranque', STARTUP),
      entry('Limpieza', SCHEDULE),
    ];

    it('puts the startup workflow first and keeps the stored order after it', () => {
      expect(ids(listWorkflows(entries, { query: '', filter: 'all' }))).toEqual(
        ['Arranque', 'Backup', 'Demo', 'Limpieza'],
      );
    });

    it('keeps only the trigger kind a filter chip picks', () => {
      expect(
        ids(listWorkflows(entries, { query: '', filter: 'schedule' })),
      ).toEqual(['Backup', 'Limpieza']);
      expect(
        ids(listWorkflows(entries, { query: '', filter: 'startup' })),
      ).toEqual(['Arranque']);
      expect(
        ids(listWorkflows(entries, { query: '', filter: 'manual' })),
      ).toEqual(['Demo']);
    });

    it('searches names ignoring case and accents', () => {
      const named = [
        entry('a', MANUAL, {}, { name: 'Migración de datos' }),
        entry('b', MANUAL, {}, { name: 'Build' }),
      ];
      expect(
        ids(listWorkflows(named, { query: 'MIGRACION', filter: 'all' })),
      ).toEqual(['a']);
      expect(ids(listWorkflows(named, { query: '  ', filter: 'all' }))).toEqual(
        ['a', 'b'],
      );
    });

    it('counts every chip over the whole list', () => {
      expect(filterCounts(entries)).toEqual({
        all: 4,
        startup: 1,
        schedule: 2,
        manual: 1,
      });
    });
  });

  describe('paginate', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);

    it('cuts pages of ten and labels the range', () => {
      const first = paginate(items, 0);
      expect(first.items).toEqual(items.slice(0, 10));
      expect(first).toMatchObject({ page: 0, pages: 3, label: '1–10 de 23' });
      expect(paginate(items, 2)).toMatchObject({
        items: [20, 21, 22],
        label: '21–23 de 23',
      });
    });

    it('clamps a page that no longer exists', () => {
      expect(paginate(items, 9).page).toBe(2);
      expect(paginate(items, -1).page).toBe(0);
    });

    it('has one empty page for nothing', () => {
      expect(paginate([], 3)).toEqual({
        items: [],
        page: 0,
        pages: 1,
        label: '0 de 0',
      });
    });
  });

  describe('scheduleSummary', () => {
    it('folds a run of weekdays into a range', () => {
      expect(
        scheduleSummary({
          rules: [{ time: '23:30', days: [1, 2, 3, 4, 5] }],
          interval: null,
        }),
      ).toBe('L–V a las 23:30');
    });

    it('lists scattered days and says every day for none or all seven', () => {
      expect(
        scheduleSummary({
          rules: [{ time: '08:00', days: [5, 1, 3] }],
          interval: null,
        }),
      ).toBe('L, X, V a las 08:00');
      expect(
        scheduleSummary({
          rules: [{ time: '09:00', days: [] }],
          interval: null,
        }),
      ).toBe('cada día a las 09:00');
      expect(
        scheduleSummary({
          rules: [{ time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }],
          interval: null,
        }),
      ).toBe('cada día a las 09:00');
      expect(
        scheduleSummary({
          rules: [{ time: '10:00', days: [6, 0] }],
          interval: null,
        }),
      ).toBe('S, D a las 10:00');
    });

    it('words an interval, singular included', () => {
      const every = (n: number, unit: 'minutes' | 'hours') =>
        scheduleSummary({ rules: [], interval: { every: n, unit } });
      expect(every(2, 'hours')).toBe('cada 2 horas');
      expect(every(1, 'hours')).toBe('cada hora');
      expect(every(15, 'minutes')).toBe('cada 15 minutos');
      expect(every(1, 'minutes')).toBe('cada minuto');
    });

    it('joins several rules and says when there is none', () => {
      expect(
        scheduleSummary({
          rules: [{ time: '09:00', days: [1] }],
          interval: { every: 3, unit: 'hours' },
        }),
      ).toBe('L a las 09:00 · cada 3 horas');
      expect(scheduleSummary({ rules: [], interval: null })).toBe(
        'Sin horario',
      );
    });
  });

  describe('durations and dates', () => {
    it('formats a run length the way the list shows it', () => {
      expect(formatDuration(6_000)).toBe('6s');
      expect(formatDuration(42_400)).toBe('42s');
      expect(formatDuration(108_000)).toBe('1m 48s');
      expect(formatDuration(125_000)).toBe('2m 05s');
      expect(formatDuration(3_720_000)).toBe('1h 02m');
      expect(formatDuration(-5)).toBe('0s');
    });

    it('keeps a tenth of a second under ten seconds where precision helps', () => {
      expect(formatPreciseDuration(3_240)).toBe('3.2s');
      expect(formatPreciseDuration(42_000)).toBe('42s');
    });

    it('formats a running clock', () => {
      expect(formatClock(12_300)).toBe('0:12');
      expect(formatClock(65_000)).toBe('1:05');
      expect(formatClock(3_725_000)).toBe('62:05');
    });

    it('writes the last run as when it started and how long it took', () => {
      expect(
        lastRunText(
          {
            startedAt: at(5, 9, 2),
            finishedAt: at(5, 9, 4),
            durationMs: 108_000,
            result: 'success',
          },
          NOW,
        ),
      ).toBe('hoy 09:02 · 1m 48s');
      expect(lastRunText(null, NOW)).toBe('Nunca');
    });

    it('says how long ago something finished', () => {
      expect(formatAgo(NOW - 20_000, NOW)).toBe('ahora');
      expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('hace 5 min');
      expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe('hace 3 h');
      expect(formatAgo(at(1, 10, 0), NOW)).toBe('jue 10:00');
    });

    it('says when a schedule fires next', () => {
      expect(nextRunText(at(5, 23, 30), NOW)).toBe('hoy a las 23:30');
      expect(nextRunText(at(6, 8, 0), NOW)).toBe('mañana a las 08:00');
    });
  });

  describe('workflowStatus', () => {
    const run = {
      startedAt: at(5, 9, 0),
      finishedAt: at(5, 9, 1),
      durationMs: 60_000,
    };

    it('shows a running workflow with its progress, enabled or not', () => {
      const running = {
        runId: 1,
        doneScripts: 3,
        totalScripts: 8,
        startedAt: NOW,
      };
      expect(workflowStatus(entry('a', MANUAL, { running }))).toEqual({
        kind: 'running',
        label: 'Ejecutando · 3/8',
      });
      expect(
        workflowStatus(entry('a', MANUAL, { running }, { enabled: false })),
      ).toMatchObject({ kind: 'running' });
    });

    it('calls a disabled one inactive whatever its last run said', () => {
      expect(
        workflowStatus(
          entry(
            'a',
            MANUAL,
            { lastRun: { ...run, result: 'error' } },
            { enabled: false },
          ),
        ),
      ).toEqual({ kind: 'inactive', label: 'Inactivo' });
    });

    it('names how the last run ended', () => {
      const ended = (result: 'success' | 'warning' | 'error' | 'cancelled') =>
        workflowStatus(entry('a', MANUAL, { lastRun: { ...run, result } }))
          .label;
      expect(ended('success')).toBe('Correcto');
      expect(ended('warning')).toBe('Con avisos');
      expect(ended('error')).toBe('Error');
      expect(ended('cancelled')).toBe('Cancelado');
      expect(workflowStatus(entry('a', MANUAL))).toEqual({
        kind: 'never',
        label: 'Sin ejecutar',
      });
    });

    it('counts the running workflows for the nav badge', () => {
      const running = {
        runId: 1,
        doneScripts: 0,
        totalScripts: 1,
        startedAt: NOW,
      };
      expect(
        runningCount([
          entry('a', MANUAL, { running }),
          entry('b', MANUAL),
          entry('c', STARTUP, { running }),
        ]),
      ).toBe(2);
    });
  });

  describe('scriptsLine', () => {
    const groups = [
      normalizeGroup({ id: 'back', name: 'Back', path: '/b' }),
      normalizeGroup({ id: 'front', name: 'Front', path: '/f' }),
      normalizeGroup({ id: 'ops', name: 'Ops', path: '/o' }),
    ];
    const graphOf = (refs: Array<[string, string]>): Pipeline => ({
      blocks: refs.map(([groupId, scriptId], i) => ({
        id: `b${i}`,
        scripts: [{ groupId, scriptId }],
        x: 0,
        y: 0,
        requireAll: true,
      })),
      edges: [],
    });
    const line = (refs: Array<[string, string]>): string =>
      scriptsLine(
        entry('a', MANUAL, {}, { graph: graphOf(refs) }).workflow,
        groups,
      );

    it('names up to two groups, then counts them', () => {
      expect(line([['back', 'x']])).toBe('1 script · Back');
      expect(
        line([
          ['back', 'x'],
          ['front', 'y'],
          ['back', 'z'],
        ]),
      ).toBe('3 scripts · Back, Front');
      expect(
        line([
          ['back', 'x'],
          ['front', 'y'],
          ['ops', 'z'],
        ]),
      ).toBe('3 scripts · 3 grupos');
    });

    it('says only the count for an empty graph', () => {
      expect(line([])).toBe('0 scripts');
    });
  });
});
