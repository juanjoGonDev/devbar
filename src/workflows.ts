/**
 * The workflow list's rules, as pure functions over `Workflow[]`:
 * - lenient reads of what the store holds (`normalizeWorkflows`),
 * - strict validation of what a renderer or a backup sends
 *   (`validateWorkflow`), with user-facing (Spanish) reasons,
 * - the single-startup invariant (`makeStartup`), the migration from the old
 *   single pipeline (`workflowsFromPipeline`) and ref pruning.
 *
 * Invariants: at most ONE workflow has the `startup` trigger; within one
 * workflow a script appears at most once (the graph's own rule, see
 * src/pipeline-graph.ts), though it may appear in several workflows.
 */
import type {
  Group,
  Pipeline,
  PreStepScriptRef,
  ScheduleInterval,
  Workflow,
  WorkflowSchedule,
  WorkflowTrigger,
} from './domain-types.js';
import { normalizePipeline, validatePipeline } from './pipeline-graph.js';
import { prunePipelineRefs } from './groups/pipeline-ops.js';
import { normalizeScheduleRule } from './groups/normalize.js';

/** What the migrated single pipeline is called. */
export const STARTUP_WORKFLOW_NAME = 'Arranque';
const DEFAULT_NAME = 'Workflow';

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function newWorkflowId(): string {
  return globalThis.crypto.randomUUID();
}

/** The manual trigger a demoted startup workflow (or a bad one) becomes. */
function manualTrigger(): WorkflowTrigger {
  return { kind: 'manual', confirm: false };
}

/**
 * The workflow's own `hidden`, else the old «Mostrar en la barra» flag it (or
 * a legacy manual trigger) carried, turned around. The old phone flag is
 * dropped: the one flag now covers the tray and the phone.
 */
function readHidden(raw: Raw): boolean {
  if (typeof raw.hidden === 'boolean') return raw.hidden;
  const legacy = raw.showInTray ?? record(raw.trigger).showInTray;
  return typeof legacy === 'boolean' ? !legacy : false;
}

const INTERVAL_LIMITS = { minutes: 1440, hours: 168 } as const;

function normalizeInterval(value: unknown): ScheduleInterval | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  const unit = raw.unit === 'hours' ? 'hours' : 'minutes';
  const every = Math.round(Number(raw.every));
  return {
    every: Number.isFinite(every)
      ? Math.min(INTERVAL_LIMITS[unit], Math.max(1, every))
      : 1,
    unit,
  };
}

function normalizeSchedule(value: unknown): WorkflowSchedule {
  const raw = record(value);
  return {
    rules: Array.isArray(raw.rules) ? raw.rules.map(normalizeScheduleRule) : [],
    interval: normalizeInterval(raw.interval),
  };
}

type TriggerKind = WorkflowTrigger['kind'];
const TRIGGER_KINDS: readonly TriggerKind[] = ['startup', 'schedule', 'manual'];

function triggerKind(value: unknown): TriggerKind | null {
  const kind = record(value).kind;
  return TRIGGER_KINDS.find((candidate) => candidate === kind) ?? null;
}

/** Lenient: an unknown trigger reads as manual. */
function normalizeTrigger(value: unknown): WorkflowTrigger {
  const raw = record(value);
  switch (triggerKind(value)) {
    case 'startup':
      return { kind: 'startup' };
    case 'schedule':
      return { kind: 'schedule', schedule: normalizeSchedule(raw.schedule) };
    case 'manual':
      return { kind: 'manual', confirm: raw.confirm === true };
    default:
      return manualTrigger();
  }
}

function normalizeOne(value: unknown, id: string): Workflow {
  const raw = record(value);
  const trigger = normalizeTrigger(raw.trigger);
  return {
    id,
    name: text(raw.name) || DEFAULT_NAME,
    enabled: raw.enabled !== false,
    hidden: readHidden(raw),
    trigger,
    graph: normalizePipeline(raw.graph),
  };
}

/**
 * Lenient read of the stored list: a repeated or missing id is re-minted, and
 * every startup workflow after the first becomes manual (keeping its flags),
 * so the single-startup invariant holds whatever the file says.
 */
export function normalizeWorkflows(
  value: unknown,
  newId: () => string = newWorkflowId,
): Workflow[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  let startupSeen = false;
  return value.map((candidate) => {
    let id = text(record(candidate).id);
    while (!id || used.has(id)) id = newId();
    used.add(id);
    const workflow = normalizeOne(candidate, id);
    if (workflow.trigger.kind !== 'startup') return workflow;
    if (!startupSeen) {
      startupSeen = true;
      return workflow;
    }
    return { ...workflow, trigger: manualTrigger() };
  });
}

export function startupWorkflow(
  workflows: readonly Workflow[],
): Workflow | null {
  return workflows.find((w) => w.trigger.kind === 'startup') ?? null;
}

/**
 * Moves the startup trigger to `workflowId`. The workflow that had it becomes
 * manual and keeps its own `hidden`.
 */
export function makeStartup(
  workflows: readonly Workflow[],
  workflowId: string,
): Workflow[] {
  if (!workflows.some((w) => w.id === workflowId)) return [...workflows];
  return workflows.map((w) => {
    if (w.id === workflowId) return { ...w, trigger: { kind: 'startup' } };
    if (w.trigger.kind === 'startup') return { ...w, trigger: manualTrigger() };
    return w;
  });
}

export function createWorkflow(
  name: string,
  trigger: WorkflowTrigger,
  newId: () => string = newWorkflowId,
): Workflow {
  const normalized = normalizeTrigger(trigger);
  return {
    id: newId(),
    name: text(name) || DEFAULT_NAME,
    enabled: true,
    hidden: false,
    trigger: normalized,
    graph: { blocks: [], edges: [] },
  };
}

/**
 * The migration from the single global pipeline: it becomes the startup
 * workflow «Arranque», armed when the old «Auto al arrancar» was on. An empty
 * pipeline migrates to no workflow at all.
 */
export function workflowsFromPipeline(
  pipeline: Pipeline,
  enabled: boolean,
  newId: () => string = newWorkflowId,
): Workflow[] {
  if (pipeline.blocks.length === 0) return [];
  return [
    {
      id: newId(),
      name: STARTUP_WORKFLOW_NAME,
      enabled,
      hidden: false,
      trigger: { kind: 'startup' },
      graph: pipeline,
    },
  ];
}

export type WorkflowValidation =
  { ok: true; workflow: Workflow } | { ok: false; error: string };

/**
 * Strict read of one workflow a renderer (or a backup) sends. `others` is the
 * list it is joining — the stored one for a save — and is only consulted for
 * the single-startup rule; an entry with the same id is the workflow itself.
 * `resolves` says whether a ref points at a script that exists.
 */
export function validateWorkflow(
  value: unknown,
  options: {
    others: readonly Workflow[];
    resolves?: (ref: PreStepScriptRef) => boolean;
    newId?: () => string;
  },
): WorkflowValidation {
  const raw = record(value);
  const name = text(raw.name);
  if (!name) return { ok: false, error: 'El workflow necesita un nombre' };
  if (!triggerKind(raw.trigger))
    return { ok: false, error: 'Disparador desconocido' };
  const id = text(raw.id) || (options.newId ?? newWorkflowId)();
  const trigger = normalizeTrigger(raw.trigger);
  if (
    trigger.kind === 'startup' &&
    options.others.some((w) => w.id !== id && w.trigger.kind === 'startup')
  )
    return { ok: false, error: 'Ya hay un workflow de arranque' };
  const graph = validatePipeline(
    raw.graph,
    options.resolves ? { resolves: options.resolves } : {},
  );
  if (!graph.ok) return graph;
  return {
    ok: true,
    workflow: {
      id,
      name,
      enabled: raw.enabled !== false,
      hidden: readHidden(raw),
      trigger,
      graph: graph.pipeline,
    },
  };
}

/** `prunePipelineRefs` over every workflow's graph (run on each persist). */
export function pruneWorkflowRefs(
  workflows: readonly Workflow[],
  groups: readonly Group[],
): Workflow[] {
  return workflows.map((w) => {
    const graph = prunePipelineRefs(w.graph, groups);
    return graph === w.graph ? w : { ...w, graph };
  });
}
