/**
 * Getting a `Pipeline` out of untrusted JSON, three ways:
 * - `normalizePipeline` — lenient and total, for what the store holds: drops
 *   whatever breaks an invariant instead of failing the read.
 * - `validatePipeline` — strict, for what a renderer or a backup file sends:
 *   refuses the whole graph with a user-facing (Spanish) reason.
 * - `fromLegacySteps` — the old ordered list of steps, as a chain.
 * plus `pruneRefs`, the referential-integrity pass every persist runs.
 */
import type {
  Pipeline,
  PipelineBlock,
  PipelineEdge,
  PreStepScriptRef,
} from '../domain-types.js';
import {
  PIPELINE_TRIGGER,
  autoLayout,
  canConnect,
  emptyPipeline,
  pipelineRefKey,
} from './graph.js';
import { connect, newBlockId } from './edit.js';

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** «Todos OK» is on unless explicitly turned off. */
function requireAllOf(value: unknown): boolean {
  return value !== false;
}

function scriptRef(value: unknown): PreStepScriptRef | null {
  const raw = record(value);
  const groupId = text(raw.groupId);
  const scriptId = text(raw.scriptId);
  return groupId && scriptId ? { groupId, scriptId } : null;
}

function refsOf(value: unknown): PreStepScriptRef[] {
  return Array.isArray(value)
    ? value
        .map(scriptRef)
        .filter((ref): ref is PreStepScriptRef => ref !== null)
    : [];
}

/** An id unused so far (and never `'trigger'`): `wanted` when it qualifies. */
function claimId(
  wanted: string,
  used: Set<string>,
  newId: () => string,
): string {
  let id = wanted && wanted !== PIPELINE_TRIGGER ? wanted : newId();
  while (used.has(id) || id === PIPELINE_TRIGGER) id = newId();
  used.add(id);
  return id;
}

/**
 * Lenient read: a script placed twice keeps its first placement, blank refs
 * and the blocks they empty are dropped (with their edges), a repeated or
 * `'trigger'` block id is re-minted, a missing position is 0, and an edge
 * that is dangling, repeated, a self edge, into the trigger or cycle-closing
 * is dropped (edges are taken in stored order). Refs to scripts that no
 * longer exist are kept: `pruneRefs` handles those on persist.
 */
export function normalizePipeline(
  value: unknown,
  newId: () => string = newBlockId,
): Pipeline {
  const raw = record(value);
  const usedIds = new Set<string>();
  const placed = new Set<string>();
  const blocks: PipelineBlock[] = [];
  for (const candidate of Array.isArray(raw.blocks) ? raw.blocks : []) {
    const rawBlock = record(candidate);
    const scripts = refsOf(rawBlock.scripts).filter((ref) => {
      const key = pipelineRefKey(ref);
      if (placed.has(key)) return false;
      placed.add(key);
      return true;
    });
    if (scripts.length === 0) continue;
    blocks.push({
      id: claimId(text(rawBlock.id), usedIds, newId),
      scripts,
      x: coordinate(rawBlock.x),
      y: coordinate(rawBlock.y),
      requireAll: requireAllOf(rawBlock.requireAll),
    });
  }
  let pipeline: Pipeline = { blocks, edges: [] };
  for (const candidate of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = record(candidate);
    pipeline = connect(pipeline, text(edge.from), text(edge.to));
  }
  return pipeline;
}

export type PipelineValidation =
  { ok: true; pipeline: Pipeline } | { ok: false; error: string };

const CONNECT_ERRORS = {
  self: 'Un bloque no puede depender de sí mismo',
  into_trigger: 'Nada puede conectarse hacia el disparador',
  unknown_block: 'Una conexión apunta a un bloque inexistente',
  duplicate: 'Conexión repetida',
  cycle: 'El pipeline tiene un ciclo',
} as const;

function validateBlocks(
  rawBlocks: readonly unknown[],
  resolves: (ref: PreStepScriptRef) => boolean,
  newId: () => string,
): { ok: true; blocks: PipelineBlock[] } | { ok: false; error: string } {
  const usedIds = new Set<string>();
  const placed = new Set<string>();
  const blocks: PipelineBlock[] = [];
  for (const candidate of rawBlocks) {
    const rawBlock = record(candidate);
    const rawScripts = Array.isArray(rawBlock.scripts) ? rawBlock.scripts : [];
    const scripts = refsOf(rawScripts);
    if (scripts.length === 0 || scripts.length !== rawScripts.length)
      return scripts.length === 0
        ? { ok: false, error: 'Un bloque no tiene scripts' }
        : { ok: false, error: 'Un bloque tiene una referencia inválida' };
    for (const ref of scripts) {
      if (!resolves(ref))
        return {
          ok: false,
          error: 'Un bloque referencia un grupo o script inexistente',
        };
      const key = pipelineRefKey(ref);
      if (placed.has(key))
        return { ok: false, error: 'Un script aparece en más de un bloque' };
      placed.add(key);
    }
    const wanted = text(rawBlock.id);
    if (wanted === PIPELINE_TRIGGER)
      return { ok: false, error: 'Un bloque no puede llamarse «trigger»' };
    if (wanted && usedIds.has(wanted))
      return { ok: false, error: 'Dos bloques comparten id' };
    blocks.push({
      id: claimId(wanted, usedIds, newId),
      scripts,
      x: coordinate(rawBlock.x),
      y: coordinate(rawBlock.y),
      requireAll: requireAllOf(rawBlock.requireAll),
    });
  }
  return { ok: true, blocks };
}

/**
 * Strict read of a whole graph: the first broken invariant refuses it with a
 * reason the user can act on. A block without an id gets a fresh one (a
 * renderer may send a block it has just created); a missing position is 0.
 * `resolves` says whether a ref points at a script that exists (default:
 * every ref does).
 */
export function validatePipeline(
  value: unknown,
  options: {
    /** Defaults to accepting every ref. */
    resolves?: (ref: PreStepScriptRef) => boolean;
    newId?: () => string;
  } = {},
): PipelineValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'El pipeline debe ser un objeto' };
  const raw = value as Raw;
  if (!Array.isArray(raw.blocks) || !Array.isArray(raw.edges))
    return { ok: false, error: 'El pipeline necesita blocks y edges' };
  const blocks = validateBlocks(
    raw.blocks,
    options.resolves ?? (() => true),
    options.newId ?? newBlockId,
  );
  if (!blocks.ok) return blocks;
  let pipeline: Pipeline = { blocks: blocks.blocks, edges: [] };
  for (const candidate of raw.edges) {
    const rawEdge = record(candidate);
    const edge: PipelineEdge = {
      from: text(rawEdge.from),
      to: text(rawEdge.to),
    };
    const rejection = canConnect(pipeline, edge.from, edge.to);
    if (rejection) return { ok: false, error: CONNECT_ERRORS[rejection] };
    pipeline = { blocks: pipeline.blocks, edges: [...pipeline.edges, edge] };
  }
  return { ok: true, pipeline };
}

/**
 * The old ordered steps as a chain: trigger → step 1 → step 2 → … Each step
 * becomes one block (a parallel frame when it holds several scripts) and
 * keeps its id; a legacy `serial` step with several scripts becomes that
 * many consecutive single-script blocks, the first keeping the step's id —
 * the old runner ran them one after another, so execution is unchanged. A
 * script placed twice keeps its first step, an empty step is skipped, and
 * positions come from `autoLayout`.
 */
export function fromLegacySteps(
  steps: readonly unknown[],
  newId: () => string = newBlockId,
): Pipeline {
  if (!Array.isArray(steps)) return emptyPipeline();
  const usedIds = new Set<string>();
  const placed = new Set<string>();
  const blocks: PipelineBlock[] = [];
  for (const candidate of steps) {
    const rawStep = record(candidate);
    const scripts = refsOf(rawStep.scripts).filter((ref) => {
      const key = pipelineRefKey(ref);
      if (placed.has(key)) return false;
      placed.add(key);
      return true;
    });
    if (scripts.length === 0) continue;
    const groups =
      rawStep.mode === 'serial' ? scripts.map((ref) => [ref]) : [scripts];
    groups.forEach((group, index) =>
      blocks.push({
        id: claimId(index === 0 ? text(rawStep.id) : '', usedIds, newId),
        scripts: group,
        x: 0,
        y: 0,
        requireAll: true,
      }),
    );
  }
  const edges = blocks.map((block, index) => ({
    from: index === 0 ? PIPELINE_TRIGGER : (blocks[index - 1]?.id ?? ''),
    to: block.id,
  }));
  return autoLayout({ blocks, edges });
}

/**
 * Drops every ref `exists` rejects. A block that empties is removed, and its
 * sources are wired straight to its targets — deleting a script must not
 * silently stop the blocks that came after it from running.
 */
export function pruneRefs(
  pipeline: Pipeline,
  exists: (ref: PreStepScriptRef) => boolean,
): Pipeline {
  if (pipeline.blocks.every((block) => block.scripts.every(exists)))
    return pipeline;
  let next: Pipeline = pipeline;
  for (const block of pipeline.blocks) {
    const scripts = block.scripts.filter(exists);
    if (scripts.length === block.scripts.length) continue;
    if (scripts.length > 0) {
      next = {
        blocks: next.blocks.map((b) =>
          b.id === block.id ? { ...b, scripts } : b,
        ),
        edges: next.edges,
      };
      continue;
    }
    next = bridgeOut(next, block.id);
  }
  return next;
}

/** Removes `blockId`, wiring each of its sources to each of its targets. */
function bridgeOut(pipeline: Pipeline, blockId: string): Pipeline {
  const sources = pipeline.edges
    .filter((edge) => edge.to === blockId)
    .map((edge) => edge.from);
  const targets = pipeline.edges
    .filter((edge) => edge.from === blockId)
    .map((edge) => edge.to);
  let next: Pipeline = {
    blocks: pipeline.blocks.filter((block) => block.id !== blockId),
    edges: pipeline.edges.filter(
      (edge) => edge.from !== blockId && edge.to !== blockId,
    ),
  };
  for (const source of sources)
    for (const target of targets) next = connect(next, source, target);
  return next;
}
