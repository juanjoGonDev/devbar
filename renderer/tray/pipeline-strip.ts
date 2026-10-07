import { formatUptime } from '../format-uptime.js';
import type { PipelineState } from '../../src/ipc-contract.js';
import {
  paintStrip,
  stripIcon,
  stripIconButton,
  stripProgress,
  stripSpan,
  stripTextButton,
} from './strip.js';

/**
 * The pipeline's slim strip under the header row: the step in flight, its
 * elapsed time, cancel and logs while it runs; the ✓ / ✕ result while main
 * keeps it (3 s / 5 s). Only the ⏩ trigger stays in the header row itself.
 * Hidden while the pipeline is idle.
 */

/**
 * How far along the bar sits: the middle of the current step's share. The
 * runner reports the step, not progress inside it, so a midpoint never claims
 * a step finished (or not begun) when it is merely running.
 */
function pipelineProgress(currentStep: number, totalSteps: number): number {
  const total = Math.max(1, totalSteps);
  const current = Math.min(Math.max(1, currentStep), total);
  return ((current - 0.5) / total) * 100;
}

/** `step_2_failed` → 2: the runner's reason for a failed step. */
function failedStep(lastError: string | null): number | null {
  const match = /^step_(\d+)_failed$/.exec(lastError ?? '');
  return match?.[1] ? Number(match[1]) : null;
}

/** Identifies one result, so a dismissed one stays dismissed when re-pushed. */
const resultKey = (state: PipelineState): string =>
  `${state.status}:${state.lastRunId ?? ''}:${state.lastError ?? ''}`;

let dismissedKey: string | null = null;

function logsButton(runId: string): HTMLButtonElement {
  return stripIconButton(
    'prestep-logs-btn',
    'scroll-text',
    'Ver logs del pipeline',
    () => void window.api.openLogs(`pre-pipeline:${runId}`),
  );
}

function stripContent(state: PipelineState): Node[] | null {
  const total = state.totalSteps;
  if (state.status === 'running') {
    const current = state.currentStep || 1;
    const nodes: Node[] = [
      stripSpan(
        'strip-title',
        `Paso ${current}/${total || 1}`,
        `Pipeline: paso ${current}/${total || 1}`,
      ),
      stripSpan('strip-spacer'),
    ];
    if (state.startedAt) {
      const elapsed = stripSpan(
        'uptime',
        formatUptime(Date.now() - state.startedAt),
      );
      elapsed.dataset.startedAt = String(state.startedAt);
      nodes.push(elapsed);
    }
    if (state.lastRunId) nodes.push(logsButton(state.lastRunId));
    nodes.push(
      stripIconButton('prestep-cancel', 'x', 'Cancelar pipeline', () => {
        void window.api.cancelPreScripts();
      }),
      stripProgress(pipelineProgress(current, total)),
    );
    return nodes;
  }
  if (state.status === 'done') {
    const nodes: Node[] = [
      stripIcon('check', 'strip-ok'),
      stripSpan('strip-title', 'Pipeline completado'),
      stripSpan('strip-detail', `${total} paso${total === 1 ? '' : 's'}`),
    ];
    if (state.lastRunId) nodes.push(logsButton(state.lastRunId));
    nodes.push(stripProgress(100));
    return nodes;
  }
  if (state.status === 'error') {
    const step = failedStep(state.lastError);
    const detail = step === null ? (state.lastError ?? '') : '';
    const nodes: Node[] = [
      stripIcon('x', 'strip-err'),
      stripSpan(
        'strip-title',
        step === null
          ? 'Error en el pipeline'
          : `Falló el paso ${step}/${total}`,
      ),
      stripSpan('strip-detail', detail, detail),
    ];
    const runId = state.lastRunId;
    if (runId)
      nodes.push(
        stripTextButton(
          'Ver logs',
          () => void window.api.openLogs(`pre-pipeline:${runId}`),
        ),
      );
    nodes.push(
      stripIconButton('prestep-cancel', 'x', 'Descartar', () => {
        dismissedKey = resultKey(state);
        renderPipelineStrip(state);
      }),
    );
    return nodes;
  }
  return null;
}

export function renderPipelineStrip(state: PipelineState | null): void {
  const el = document.getElementById('pipeline-strip');
  if (!el) return;
  // A dismissal holds only for the result it dismissed.
  if (state && dismissedKey !== resultKey(state)) dismissedKey = null;
  paintStrip(el, state && dismissedKey === null ? stripContent(state) : null);
}
