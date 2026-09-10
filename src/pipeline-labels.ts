/**
 * User-facing labels for the global pre-script pipeline log.
 *
 * Pure and dependency-free so both the runner (which writes the lines) and
 * `main.ts` (which names each run in the log list) can share them, and so
 * they stay unit-testable without Electron — same shape as `format-uptime.ts`.
 *
 * These strings are Spanish because they are DevBar narrating its own work to
 * the user, and the rest of the app's UI is Spanish. Output produced BY the
 * scripts themselves is passed through untouched, whatever language it is in.
 */

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * `Back · Make setup`.
 *
 * The group comes first and is never omitted when present: two groups can
 * each define a script called "Make setup", and with the bare script name
 * the log is genuinely ambiguous about which one ran.
 */
export function formatScriptLabel(
  groupName: string,
  scriptName: string,
): string {
  const group = groupName.trim();
  return group ? `${group} · ${scriptName}` : scriptName;
}

/**
 * `Pipeline · 12:47:13`.
 *
 * Every run lands in the same log bucket, so the start time is the only thing
 * that tells two of them apart in the sidebar.
 */
export function formatPipelineRunName(runId: number): string {
  const at = new Date(runId);
  return `Pipeline · ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
}

/** `1 paso` / `2 pasos`. */
export function formatStepCount(steps: number): string {
  return `${steps} paso${steps === 1 ? '' : 's'}`;
}

/** `serie` / `paralelo`. */
export function formatStepMode(mode: 'parallel' | 'serial'): string {
  return mode === 'serial' ? 'serie' : 'paralelo';
}
