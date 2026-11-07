import type { WorkflowRunResult } from '../../src/domain-types.js';
import type {
  RemoteStateView,
  RemoteWorkflowTrigger,
  RemoteWorkflowView,
} from '../../src/ipc-contract/remote-wire.js';
import { spinPhase } from '../spin-phase.js';
import { formatWhen } from '../tray/workflow-format.js';
import type { PanelContext } from './context.js';
import type { PanelElements } from './elements.js';
import { foldToggle } from './fold.js';
import { elapsed } from './format.js';
import { glyph, type GlyphName } from './glyphs.js';
import { button, el } from './view.js';

/**
 * «Workflows»: the runs in flight («En curso»: scripts done, time running,
 * a bar, and a stop button) and the ones the phone may start
 * («Disponibles»: how each fires and how it last went), the ones hidden from
 * the tray behind their fold. The list is the tray's (the server sends only
 * those); runs and stops go through `workflow.run` / `workflow.stop`.
 */

const PENDING = 'Pendiente de confirmación';

const TRIGGER: Record<
  RemoteWorkflowTrigger,
  { text: string; icon: GlyphName }
> = {
  manual: { text: 'Manual', icon: 'play' },
  schedule: { text: 'Programado', icon: 'clock' },
  startup: { text: 'Al arrancar', icon: 'zap' },
};

const RESULT_TEXT: Record<WorkflowRunResult, string> = {
  success: 'correcto',
  warning: 'con avisos',
  error: 'falló',
  cancelled: 'cancelado',
};

export interface WorkflowsTab {
  render(state: RemoteStateView): void;
}

export function createWorkflowsTab(
  els: PanelElements['workflows'],
  ctx: PanelContext,
): WorkflowsTab {
  let hiddenOpen = false;
  /** Workflow ids with a request in flight. */
  const busy = new Set<string>();
  let last: RemoteStateView | null = null;

  const repaint = (): void => {
    if (last) render(last);
  };

  async function send(
    workflow: RemoteWorkflowView,
    op: 'workflow.run' | 'workflow.stop',
  ): Promise<void> {
    busy.add(workflow.id);
    repaint();
    await ctx.run(
      op,
      { workflowId: workflow.id },
      op === 'workflow.run' ? { pending: PENDING } : {},
    );
    busy.delete(workflow.id);
    repaint();
  }

  function tile(trigger: RemoteWorkflowTrigger): HTMLElement {
    const box = el('span', `wf-tile is-${trigger}`);
    box.setAttribute('aria-hidden', 'true');
    box.append(glyph(TRIGGER[trigger].icon, 17));
    return box;
  }

  /** «Manual · lun 17:12 · con avisos», the result in its colour. */
  function subtitle(workflow: RemoteWorkflowView): HTMLElement {
    const now = ctx.serverNow();
    const parts = [TRIGGER[workflow.trigger].text];
    let result: WorkflowRunResult | null = null;
    if (workflow.trigger === 'schedule') {
      if (workflow.nextRunAt !== null)
        parts.push(formatWhen(workflow.nextRunAt, now));
      if (workflow.lastResult === 'error') result = 'error';
    } else if (workflow.lastFinishedAt !== null && workflow.lastResult) {
      parts.push(formatWhen(workflow.lastFinishedAt, now));
      result = workflow.lastResult;
    }
    const sub = el('span', 'wf-sub', parts.join(' · '));
    if (result)
      sub.append(
        ' · ',
        el('span', `wf-result is-${result}`, RESULT_TEXT[result]),
      );
    return sub;
  }

  function runningRow(
    workflow: RemoteWorkflowView,
    ticks: (() => void)[],
  ): HTMLElement {
    const row = el('div', 'wf-row is-running');
    const text = el('span', 'wf-text');
    const line = el('span', 'wf-line');
    const sub = el('span', 'wf-sub');
    const done = workflow.doneScripts ?? 0;
    const total = workflow.totalScripts;
    const since = workflow.startedAt;
    const paint = (): void => {
      sub.textContent =
        since === null
          ? `${done}/${total}`
          : `${done}/${total} · ${elapsed(ctx.serverNow() - since)}`;
    };
    paint();
    ticks.push(paint);
    line.append(spinPhase(el('span', 'spinner is-small')), sub);
    const track = el('span', 'wf-progress');
    const bar = el('span', 'wf-progress-bar');
    bar.style.width = `${total > 0 ? (Math.min(done, total) / total) * 100 : 0}%`;
    track.append(bar);
    text.append(el('span', 'wf-name', workflow.name), line, track);
    const stop = button(
      'round-button is-stop',
      `Detener ${workflow.name}`,
      () => void send(workflow, 'workflow.stop'),
    );
    stop.append(glyph('stop', 15));
    stop.disabled = busy.has(workflow.id);
    row.append(tile(workflow.trigger), text, stop);
    return row;
  }

  function idleRow(workflow: RemoteWorkflowView): HTMLElement {
    const row = el('div', 'wf-row');
    const text = el('span', 'wf-text');
    text.append(el('span', 'wf-name', workflow.name), subtitle(workflow));
    const run = button(
      'round-button is-run',
      `Ejecutar ${workflow.name}`,
      () => void send(workflow, 'workflow.run'),
    );
    run.append(glyph('play', 15));
    run.disabled = busy.has(workflow.id) || workflow.totalScripts === 0;
    row.append(tile(workflow.trigger), text, run);
    return row;
  }

  /** The idle ones in the tray's order, the hidden ones behind its fold. */
  function idleRows(idle: readonly RemoteWorkflowView[]): HTMLElement[] {
    const nodes = idle.filter((w) => !w.hidden).map(idleRow);
    const hidden = idle.filter((w) => w.hidden);
    if (hidden.length === 0) return nodes;
    nodes.push(
      foldToggle(hidden.length, hiddenOpen, () => {
        hiddenOpen = !hiddenOpen;
        repaint();
      }),
    );
    if (hiddenOpen)
      for (const workflow of hidden) {
        const row = idleRow(workflow);
        row.classList.add('is-hidden-group');
        nodes.push(row);
      }
    return nodes;
  }

  function render(state: RemoteStateView): void {
    last = state;
    const ticks: (() => void)[] = [];
    const running = state.workflows.filter((w) => w.running);
    const idle = state.workflows.filter((w) => !w.running);
    els.runningTitle.hidden = running.length === 0;
    els.running.replaceChildren(...running.map((w) => runningRow(w, ticks)));
    els.idleTitle.hidden = idle.length === 0;
    els.idle.replaceChildren(...idleRows(idle));
    els.empty.hidden = state.workflows.length > 0;
    ctx.onTick('workflows', ticks);
  }

  return { render };
}
