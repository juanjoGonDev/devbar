import type { PreStep } from '../../src/domain-types.js';

/** Joins/splits a `PreStepScriptRef` for use as a DOM `data-id` — UUIDs never
 * contain `::`, so the split is unambiguous. */
const REF_SEP = '::';
export function refToDataId(groupId: string, scriptId: string): string {
  return `${groupId}${REF_SEP}${scriptId}`;
}
export function dataIdToRef(
  dataId: string,
): { groupId: string; scriptId: string } | null {
  const [groupId, scriptId] = dataId.split(REF_SEP);
  return groupId && scriptId ? { groupId, scriptId } : null;
}

/** Same deterministic name→hue hash as `renderer/logs.ts`'s `sourceColor` —
 * duplicated rather than shared, matching this codebase's existing pattern
 * of small per-module helpers (e.g. `errorMessage` in config.ts/tray.ts). */
export function groupColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 68%)`;
}

/** One lane of the summary strip: a resolved `{group, script}` pair, or a
 * broken marker when the ref no longer resolves (matches the dimmed "ref
 * rota" treatment `buildScriptRow` already gives a dangling ref). */
export interface PipelineSummaryLane {
  readonly groupName: string;
  readonly scriptName: string;
  readonly broken: boolean;
}

/** The summary strip's view model for one step — everything `buildSummaryStrip`
 * needs and nothing it has to compute itself. */
export interface PipelineSummaryStep {
  readonly index: number;
  readonly mode: PreStep['mode'];
  /** Worth the accent treatment: parallel AND more than one script. A
   * single-script "parallel" step behaves identically to serial, so it is
   * never highlighted (matches `arranque-prototipo.html`'s `.par` rule). */
  readonly isParallel: boolean;
  readonly isEmpty: boolean;
  readonly lanes: readonly PipelineSummaryLane[];
}

/** Resolves a pipeline ref to the names the strip prints, or null when the
 * ref no longer points at anything. */
export type ResolveScriptName = (
  groupId: string,
  scriptId: string,
) => { groupName: string; scriptName: string } | null;

/**
 * Pure view-model builder for the pipeline summary strip — no DOM, so it is
 * directly unit-testable (`tests/pipeline-summary.test.ts`) the same way
 * `renderer/tooltip.ts` keeps `placeTip` pure alongside its DOM-touching code.
 */
export function summarizePipeline(
  steps: readonly PreStep[],
  resolveScript: ResolveScriptName,
): readonly PipelineSummaryStep[] {
  return steps.map((step, i) => {
    const lanes: PipelineSummaryLane[] = step.scripts.map((ref) => {
      const resolved = resolveScript(ref.groupId, ref.scriptId);
      return resolved
        ? {
            groupName: resolved.groupName,
            scriptName: resolved.scriptName,
            broken: false,
          }
        : { groupName: '', scriptName: '', broken: true };
    });
    return {
      index: i + 1,
      mode: step.mode,
      isParallel: step.mode === 'parallel' && lanes.length > 1,
      isEmpty: lanes.length === 0,
      lanes,
    };
  });
}

/**
 * The summary strip itself.
 *
 * `summarizePipeline` above is the pure view-model seam: it turns raw steps
 * into exactly what this renders, with no DOM involved, so the approved
 * layout (header line + one lane per script, matching
 * `arranque-prototipo.html`) can be driven from plain fixtures in
 * `tests/pipeline-summary.test.ts`.
 */
export function buildSummaryStrip(
  steps: readonly PreStep[],
  resolveScript: ResolveScriptName,
): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'pipeline-summary';
  const track = document.createElement('div');
  track.className = 'pipeline-summary-steps';

  for (const step of summarizePipeline(steps, resolveScript)) {
    const block = document.createElement('div');
    block.className = 'pipeline-summary-step';
    if (step.isEmpty) block.classList.add('is-empty');
    if (step.isParallel) block.classList.add('is-parallel');
    block.title = `Paso ${step.index} (${step.mode === 'serial' ? 'serie' : 'paralelo'})`;

    const head = document.createElement('span');
    head.className = 'pipeline-summary-step-head';
    head.textContent =
      step.lanes.length > 1
        ? `${step.index} · ${step.mode === 'parallel' ? '∥' : '→'}`
        : `${step.index}`;
    block.appendChild(head);

    if (step.isEmpty) {
      const lane = document.createElement('span');
      lane.className = 'pipeline-summary-lane is-muted';
      lane.textContent = 'vacío';
      block.appendChild(lane);
    } else {
      for (const lane of step.lanes) {
        const laneEl = document.createElement('span');
        laneEl.className = 'pipeline-summary-lane';
        if (lane.broken) {
          laneEl.classList.add('is-muted');
          laneEl.textContent = 'Referencia rota';
        } else {
          const dot = document.createElement('span');
          dot.className = 'pipeline-group-dot';
          dot.style.setProperty('--group-color', groupColor(lane.groupName));
          laneEl.append(dot, document.createTextNode(lane.scriptName));
        }
        block.appendChild(laneEl);
      }
    }
    track.appendChild(block);
  }
  strip.appendChild(track);

  const scriptCount = steps.reduce((sum, step) => sum + step.scripts.length, 0);
  const groupCount = new Set(
    steps.flatMap((step) => step.scripts.map((ref) => ref.groupId)),
  ).size;
  const count = document.createElement('div');
  count.className = 'pipeline-summary-count muted small';
  count.textContent = `${steps.length} paso${steps.length === 1 ? '' : 's'} · ${scriptCount} script${scriptCount === 1 ? '' : 's'} · ${groupCount} grupo${groupCount === 1 ? '' : 's'}`;
  strip.appendChild(count);
  return strip;
}
