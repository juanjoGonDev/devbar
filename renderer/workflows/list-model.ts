import { formatWhen } from '../tray/workflow-format.js';
import { formatScriptCount } from '../../src/pipeline-labels.js';
import type {
  Group,
  ScheduleInterval,
  ScheduleRule,
  Workflow,
  WorkflowRunRecord,
  WorkflowSchedule,
} from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

/**
 * What the settings' Workflows list shows: which rows, in which order and
 * page, and the wording of every cell. Pure, so it is tested without a DOM.
 */

export type WorkflowFilter = 'all' | 'startup' | 'schedule' | 'manual';

const PAGE_SIZE = 10;

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** The startup workflow first, then the stored order; filtered and searched. */
export function listWorkflows(
  entries: readonly WorkflowEntry[],
  options: { query: string; filter: WorkflowFilter },
): WorkflowEntry[] {
  const needle = fold(options.query);
  const startupFirst = [
    ...entries.filter((e) => e.workflow.trigger.kind === 'startup'),
    ...entries.filter((e) => e.workflow.trigger.kind !== 'startup'),
  ];
  return startupFirst.filter(
    (e) =>
      (options.filter === 'all' ||
        e.workflow.trigger.kind === options.filter) &&
      (needle === '' || fold(e.workflow.name).includes(needle)),
  );
}

export function filterCounts(
  entries: readonly WorkflowEntry[],
): Record<WorkflowFilter, number> {
  const count = (kind: WorkflowFilter): number =>
    entries.filter((e) => e.workflow.trigger.kind === kind).length;
  return {
    all: entries.length,
    startup: count('startup'),
    schedule: count('schedule'),
    manual: count('manual'),
  };
}

export interface Page<T> {
  items: T[];
  /** The page actually shown, clamped into range. */
  page: number;
  pages: number;
  /** `1–10 de 23`. */
  label: string;
}

export function paginate<T>(
  items: readonly T[],
  page: number,
  size = PAGE_SIZE,
): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pages - 1, Math.max(0, page));
  const start = current * size;
  const shown = items.slice(start, start + size);
  const label =
    items.length === 0
      ? '0 de 0'
      : `${start + 1}–${start + shown.length} de ${items.length}`;
  return { items: shown, page: current, pages, label };
}

// Monday-first, as the weekday chips are laid out.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const LETTER: Record<number, string> = {
  0: 'D',
  1: 'L',
  2: 'M',
  3: 'X',
  4: 'J',
  5: 'V',
  6: 'S',
};

function daysText(days: readonly number[]): string {
  const positions = [...new Set(days)]
    .map((day) => WEEK.indexOf(day))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b);
  if (positions.length === 0 || positions.length === WEEK.length)
    return 'cada día';
  const runs: number[][] = [];
  for (const position of positions) {
    const last = runs.at(-1);
    if (last && last.at(-1) === position - 1) last.push(position);
    else runs.push([position]);
  }
  const letter = (position: number): string =>
    LETTER[WEEK[position] ?? 0] ?? '';
  return runs
    .flatMap((run) =>
      run.length >= 3
        ? [`${letter(run[0] ?? 0)}–${letter(run.at(-1) ?? 0)}`]
        : run.map(letter),
    )
    .join(', ');
}

function ruleText(rule: ScheduleRule): string {
  return `${daysText(rule.days)} a las ${rule.time}`;
}

function intervalText(interval: ScheduleInterval): string {
  const [one, many] =
    interval.unit === 'hours' ? ['hora', 'horas'] : ['minuto', 'minutos'];
  return interval.every === 1
    ? `cada ${one}`
    : `cada ${interval.every} ${many}`;
}

/** `L–V a las 23:30`, `cada 2 horas`, or both joined by ` · `. */
export function scheduleSummary(schedule: WorkflowSchedule): string {
  const parts = schedule.rules.map(ruleText);
  if (schedule.interval) parts.push(intervalText(schedule.interval));
  return parts.length ? parts.join(' · ') : 'Sin horario';
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `6s`, `1m 48s`, `2m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}

/** Like `formatDuration`, with a tenth of a second under ten seconds. */
export function formatPreciseDuration(ms: number): string {
  return ms > 0 && ms < 10_000
    ? `${(ms / 1000).toFixed(1)}s`
    : formatDuration(ms);
}

/** `0:12`, `1:05`: a running clock. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

/** `hoy 09:02 · 1m 48s`, or `Nunca`. */
export function lastRunText(
  lastRun: WorkflowRunRecord | null,
  now: number,
): string {
  if (!lastRun) return 'Nunca';
  return `${formatWhen(lastRun.startedAt, now)} · ${formatDuration(lastRun.durationMs)}`;
}

/** `ahora`, `hace 5 min`, `hace 3 h`, then the day it happened. */
export function formatAgo(ts: number, now: number): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return formatWhen(ts, now);
}

/** `hoy a las 23:30`, `mañana a las 08:00`. */
export function nextRunText(ts: number, now: number): string {
  const when = formatWhen(ts, now);
  const space = when.lastIndexOf(' ');
  return `${when.slice(0, space)} a las ${when.slice(space + 1)}`;
}

export type WorkflowStatusKind =
  | 'running'
  | 'success'
  | 'warning'
  | 'error'
  | 'cancelled'
  | 'inactive'
  | 'never';

const RESULT_LABEL = {
  success: 'Correcto',
  warning: 'Con avisos',
  error: 'Error',
  cancelled: 'Cancelado',
} as const;

export function workflowStatus(entry: WorkflowEntry): {
  kind: WorkflowStatusKind;
  label: string;
} {
  if (entry.running)
    return {
      kind: 'running',
      label: `Ejecutando · ${entry.running.doneScripts}/${entry.running.totalScripts}`,
    };
  if (!entry.workflow.enabled) return { kind: 'inactive', label: 'Inactivo' };
  if (!entry.lastRun) return { kind: 'never', label: 'Sin ejecutar' };
  return {
    kind: entry.lastRun.result,
    label: RESULT_LABEL[entry.lastRun.result],
  };
}

export function runningCount(entries: readonly WorkflowEntry[]): number {
  return entries.filter((entry) => entry.running !== null).length;
}

/** `8 scripts · 4 grupos`, `3 scripts · Back, Front`. */
export function scriptsLine(
  workflow: Workflow,
  groups: readonly Group[],
): string {
  const refs = workflow.graph.blocks.flatMap((block) => block.scripts);
  const count = formatScriptCount(refs.length);
  const groupIds = [...new Set(refs.map((ref) => ref.groupId))];
  if (groupIds.length === 0) return count;
  if (groupIds.length > 2) return `${count} · ${groupIds.length} grupos`;
  const names = groupIds.map(
    (id) => groups.find((group) => group.id === id)?.name ?? '?',
  );
  return `${count} · ${names.join(', ')}`;
}
