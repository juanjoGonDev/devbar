import type {
  RemoteActionView,
  RemoteCommandView,
  RemoteGroupView,
  RemoteStateView,
  RemoteWorkflowView,
} from '../../src/ipc-contract/remote-wire.js';
import type { WorkflowRunResult } from '../../src/domain-types.js';
import { createBranchSheet } from './branch-sheet.js';
import type { PanelContext } from './context.js';
import type { PanelElements } from './elements.js';
import { countdown, mmss, plural, uptime } from './format.js';
import { glyph } from './glyphs.js';
import { button, el } from './view.js';
import { spinPhase } from '../spin-phase.js';

/**
 * «Grupos»: the computer, the error and warning totals, the banners (a
 * confirmation waiting, an update ready), the workflows the phone may run and
 * stop, and one card per group —
 * an accordion with one card open — with its branch, its services and its
 * actions. Every push repaints the cards; which one is open and which
 * buttons are mid-request survive the repaint.
 */

const PENDING = 'Pendiente de confirmación';

const RESULT_TEXT: Record<WorkflowRunResult, string> = {
  success: 'Último: correcto',
  warning: 'Último: con avisos',
  error: 'Último: falló',
  cancelled: 'Último: cancelado',
};
const RESULT_DOT: Record<WorkflowRunResult, string> = {
  success: 'running',
  warning: 'warn',
  error: 'error',
  cancelled: 'stopped',
};

export interface GroupsTab {
  render(state: RemoteStateView): void;
  /** The connection went down or came back. */
  setLive(live: boolean, everLive: boolean): void;
}

const isUp = (status: string): boolean =>
  status === 'running' || status === 'starting';

export function createGroupsTab(
  els: PanelElements['groups'],
  sheetEls: PanelElements['branches'],
  ctx: PanelContext,
  version: string,
): GroupsTab {
  const sheet = createBranchSheet(sheetEls, ctx);
  let open: string | null | undefined;
  /** The «N oculto(s)» folds, closed like the tray's until tapped. */
  let hiddenOpen = false;
  let hiddenWorkflowsOpen = false;
  /** Process ids (and `wf:<id>`) with a request in flight. */
  const busy = new Set<string>();
  let last: RemoteStateView | null = null;
  let live = false;
  let everLive = false;

  const repaint = (): void => {
    if (last) render(last);
  };
  const statusText = (): string => {
    if (live) return `Conectado · DevBar ${last?.host.version || version}`;
    return everLive ? 'Reconectando…' : 'Conectando…';
  };

  async function send(
    key: string,
    path: string,
    body: unknown,
    pending?: string,
  ): Promise<void> {
    busy.add(key);
    repaint();
    await ctx.run(path, body, pending ? { pending } : {});
    busy.delete(key);
    repaint();
  }

  function commandRow(
    command: RemoteCommandView,
    ticks: (() => void)[],
  ): HTMLElement {
    const row = el('div', 'command-row');
    const up = isUp(command.status);
    const dot = el(
      'span',
      `dot is-${up ? command.color : command.status === 'error' ? 'error' : 'stopped'}`,
    );
    dot.setAttribute('aria-hidden', 'true');
    const textBox = el('span', 'command-text');
    const title = el('span', 'command-title');
    title.append(el('span', 'command-name', command.name));
    if (command.errorCount > 0)
      title.append(
        el(
          'span',
          'badge is-error',
          plural(command.errorCount, 'error', 'errores'),
        ),
      );
    else if (command.warnCount > 0)
      title.append(
        el(
          'span',
          'badge is-warn',
          plural(command.warnCount, 'warning', 'warnings'),
        ),
      );
    const sub = el('span', 'command-sub');
    if (command.status === 'running' && command.startedAt !== null) {
      const since = command.startedAt;
      const paint = (): void => {
        sub.textContent = `En marcha · ${uptime(ctx.serverNow() - since)}`;
      };
      paint();
      ticks.push(paint);
    } else if (command.status === 'starting') sub.textContent = 'Arrancando…';
    else if (command.status === 'stopping') sub.textContent = 'Deteniendo…';
    else if (command.status === 'error')
      sub.textContent = 'Error · mira los logs';
    else sub.textContent = 'Detenido';
    textBox.append(title, sub);

    const logs = button('square-button', `Ver logs de ${command.name}`, () =>
      ctx.openLogs(command.processId),
    );
    logs.append(glyph('logs'));
    const toggle = button(
      `square-button ${up ? 'is-danger' : 'is-go'}`,
      `${up ? 'Detener' : 'Iniciar'} ${command.name}`,
      () =>
        void send(
          command.processId,
          up ? 'process.stop' : 'process.start',
          { processId: command.processId },
          up ? undefined : PENDING,
        ),
    );
    toggle.append(glyph(up ? 'stop' : 'play', 16));
    toggle.disabled = busy.has(command.processId);
    row.append(dot, textBox, logs, toggle);
    return row;
  }

  function actionChip(group: RemoteGroupView, action: RemoteActionView) {
    const running = action.status === 'running';
    const chip = button(
      'chip-button',
      `Ejecutar ${action.name}`,
      () =>
        void send(
          action.processId,
          'actions.run',
          { groupId: group.id, actionId: action.id },
          PENDING,
        ),
    );
    chip.append(
      running ? spinPhase(el('span', 'spinner is-small')) : glyph('play', 12),
      el('span', '', running ? `${action.name} · en curso` : action.name),
    );
    chip.disabled = running || busy.has(action.processId);
    return chip;
  }

  function workflowRow(workflow: RemoteWorkflowView): HTMLElement {
    const row = el('div', 'command-row workflow-row');
    const result = workflow.lastResult;
    const dot = el(
      'span',
      `dot is-${workflow.running ? 'running' : result ? RESULT_DOT[result] : 'stopped'}`,
    );
    dot.setAttribute('aria-hidden', 'true');
    const textBox = el('span', 'command-text');
    const title = el('span', 'command-title');
    title.append(el('span', 'command-name', workflow.name));
    if (workflow.startup) title.append(el('span', 'badge', 'Arranque'));
    const sub = el(
      'span',
      'command-sub',
      workflow.running
        ? `En curso · ${workflow.doneScripts ?? 0}/${workflow.totalScripts} scripts`
        : result
          ? RESULT_TEXT[result]
          : 'Sin ejecutar',
    );
    textBox.append(title, sub);
    const key = `wf:${workflow.id}`;
    const toggle = button(
      `square-button ${workflow.running ? 'is-danger' : 'is-go'}`,
      `${workflow.running ? 'Detener' : 'Ejecutar'} ${workflow.name}`,
      () =>
        void send(
          key,
          workflow.running ? 'workflow.stop' : 'workflow.run',
          { workflowId: workflow.id },
          workflow.running ? undefined : PENDING,
        ),
    );
    toggle.append(glyph(workflow.running ? 'stop' : 'play', 16));
    toggle.disabled =
      busy.has(key) || (!workflow.running && workflow.totalScripts === 0);
    row.append(dot, textBox, toggle);
    return row;
  }

  function hiddenToggle(
    count: number,
    open: boolean,
    flip: () => void,
  ): HTMLButtonElement {
    const toggle = el('button', 'hidden-groups-toggle');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      flip();
      repaint();
    });
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(
      glyph('chevron', 14),
      el('span', '', plural(count, 'oculto', 'ocultos')),
    );
    return toggle;
  }

  /** The cards in the tray's order, the hidden ones behind its fold. */
  function cards(
    groups: readonly RemoteGroupView[],
    ticks: (() => void)[],
  ): HTMLElement[] {
    const shown = groups.filter((group) => !group.hidden);
    const hidden = groups.filter((group) => group.hidden);
    const nodes = shown.map((group) => card(group, ticks));
    if (hidden.length === 0) return nodes;
    nodes.push(
      hiddenToggle(hidden.length, hiddenOpen, () => {
        hiddenOpen = !hiddenOpen;
      }),
    );
    if (hiddenOpen)
      for (const group of hidden) {
        const box = card(group, ticks);
        box.classList.add('is-hidden-group');
        nodes.push(box);
      }
    return nodes;
  }

  /** The workflows in the tray's order, the hidden ones behind its fold. */
  function workflowRows(
    workflows: readonly RemoteWorkflowView[],
  ): HTMLElement[] {
    const nodes = workflows
      .filter((workflow) => !workflow.hidden)
      .map(workflowRow);
    const hidden = workflows.filter((workflow) => workflow.hidden);
    if (hidden.length === 0) return nodes;
    nodes.push(
      hiddenToggle(hidden.length, hiddenWorkflowsOpen, () => {
        hiddenWorkflowsOpen = !hiddenWorkflowsOpen;
      }),
    );
    if (hiddenWorkflowsOpen)
      for (const workflow of hidden) {
        const row = workflowRow(workflow);
        row.classList.add('is-hidden-group');
        nodes.push(row);
      }
    return nodes;
  }

  function card(group: RemoteGroupView, ticks: (() => void)[]): HTMLElement {
    const box = el('div', 'group-card');
    const expanded = open === group.id;
    const running = group.commands.filter((c) => isUp(c.status)).length;
    const head = el('button', 'group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(expanded));
    const dot = el('span', `dot is-${group.color}`);
    dot.setAttribute('aria-hidden', 'true');
    const textBox = el('span', 'group-text');
    textBox.append(
      el('span', 'group-name', group.name),
      el(
        'span',
        'group-sub',
        `${running}/${group.commands.length} en marcha${group.branch ? ` · ${group.branch}` : ''}`,
      ),
    );
    head.append(dot, textBox, glyph('chevron', 16));
    head.addEventListener('click', () => {
      open = expanded ? null : group.id;
      repaint();
    });
    box.append(head);
    if (!expanded) return box;

    const body = el('div', 'group-body');
    if (group.branch !== null) {
      const branch = group.branch;
      const row = button(
        'branch-row',
        `Cambiar de rama, actual ${branch}`,
        () => sheet.open(group.id, branch),
      );
      row.append(
        glyph('branch', 15),
        el('span', 'mono branch-name', branch),
        el('span', 'link', 'Cambiar'),
      );
      body.append(row);
    }
    for (const command of group.commands)
      body.append(commandRow(command, ticks));
    if (group.actions.length > 0) {
      const chips = el('div', 'action-chips');
      chips.append(...group.actions.map((action) => actionChip(group, action)));
      body.append(chips);
    }
    box.append(body);
    return box;
  }

  function header(state: RemoteStateView): void {
    els.hostName.textContent = state.host.name;
    els.hostStatus.textContent = statusText();
    const commands = state.groups.flatMap((group) => group.commands);
    const errors = commands.reduce((sum, c) => sum + c.errorCount, 0);
    const warnings = commands.reduce((sum, c) => sum + c.warnCount, 0);
    els.errorChip.hidden = errors === 0;
    els.errorChip.textContent = plural(errors, 'error', 'errores');
    els.warnChip.hidden = warnings === 0;
    els.warnChip.textContent = plural(warnings, 'warning', 'warnings');
  }

  function banners(state: RemoteStateView, ticks: (() => void)[]): void {
    const [confirm] = state.confirms;
    els.confirmBanner.hidden = !confirm;
    if (confirm) {
      els.confirmBannerTitle.textContent = `¿Ejecutar «${confirm.name}»?`;
      const prefix = [confirm.groupName, 'esperando respuesta']
        .filter(Boolean)
        .join(' · ');
      const paint = (): void => {
        els.confirmBannerSub.textContent =
          confirm.deadline === null
            ? prefix
            : `${prefix} · ${mmss(countdown(confirm.deadline - ctx.serverNow()))}`;
      };
      paint();
      ticks.push(paint);
    }
    const { update } = state;
    els.updateBanner.hidden = update.state !== 'ready';
    els.updateBannerTitle.textContent = `DevBar ${update.version ?? ''} disponible`;
  }

  function render(state: RemoteStateView): void {
    last = state;
    if (open === undefined)
      open = state.groups.find((group) => !group.hidden)?.id ?? null;
    const ticks: (() => void)[] = [];
    header(state);
    banners(state, ticks);
    els.workflowsTitle.hidden = state.workflows.length === 0;
    els.workflows.replaceChildren(...workflowRows(state.workflows));
    els.empty.hidden = state.groups.length > 0;
    els.list.replaceChildren(...cards(state.groups, ticks));
    ctx.onTick('groups', ticks);
  }

  els.stopAll.addEventListener('click', () => {
    if (
      !ctx.env.confirm(
        '¿Detener todos los servicios en marcha en el ordenador?',
      )
    )
      return;
    void ctx.run('stopAll').then((answer) => {
      const stopped = answer?.body.stopped;
      if (answer?.status === 200 && typeof stopped === 'number')
        ctx.toast(
          `${plural(stopped, 'servicio detenido', 'servicios detenidos')}`,
        );
    });
  });
  els.confirmBanner.addEventListener('click', () => {
    const token = last?.confirms[0]?.token;
    if (token) ctx.openConfirm(token);
  });
  els.updateBanner.addEventListener('click', () => ctx.showTab('settings'));

  return {
    render,
    setLive: (isLive, wasLive) => {
      live = isLive;
      everLive = wasLive;
      els.hostStatus.textContent = statusText();
      repaint();
    },
  };
}
