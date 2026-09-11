/**
 * User-facing labels — and the one shared bucket identifier — for the global
 * pre-script pipeline log.
 *
 * Pure and dependency-free so both the runner (which writes the lines) and
 * `main.ts`/`renderer/logs.ts` (which name and place the pipeline's bucket in
 * the log list and sidebar) can share them, and so they stay unit-testable
 * without Electron — same shape as `format-uptime.ts`.
 *
 * These strings are Spanish because they are DevBar narrating its own work to
 * the user, and the rest of the app's UI is Spanish. Output produced BY the
 * scripts themselves is passed through untouched, whatever language it is in.
 */

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Sentinel "group" id for the pipeline aggregator log's own top-level bucket
 * in `logs:list`/`getMergedSources` — the pipeline is global now and must
 * never nest under any real group (never collides with a real group id,
 * which is always a `crypto.randomUUID()`). Shared by `main.ts` (which
 * builds the sidebar data) and `renderer/logs.ts` (which has to single out
 * this one bucket to place and render it differently) so neither side can
 * drift from the other by hand-typing the same magic string twice.
 */
export const PIPELINE_LOG_GROUP_ID = '__pipeline__';
export const PIPELINE_LOG_NAME = 'Pipeline de pre-scripts';

/**
 * `Pipeline · 12:47:13.815`.
 *
 * Every run lands in the same log bucket, so the start time is the only thing
 * that tells two of them apart in the sidebar.
 */
export function formatPipelineRunName(runId: number): string {
  const at = new Date(runId);
  // Milliseconds included on purpose: runIds are `Date.now()` stamps, and a
  // cancel-and-retry lands two runs inside the same second. The sidebar shows
  // nothing but this label to tell their logs apart.
  const ms = String(at.getMilliseconds()).padStart(3, '0');
  return `Pipeline · ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}.${ms}`;
}

/** `1 paso` / `2 pasos`. */
export function formatStepCount(steps: number): string {
  return `${steps} paso${steps === 1 ? '' : 's'}`;
}

/** `serie` / `paralelo`. */
export function formatStepMode(mode: 'parallel' | 'serial'): string {
  return mode === 'serial' ? 'serie' : 'paralelo';
}
