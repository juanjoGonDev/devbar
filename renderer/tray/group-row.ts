/**
 * One group's row in the tray: the collapsed row itself, and the command
 * sub-rows and action chips its expanded section holds.
 *
 * Split out of `renderer/tray.ts`, which keeps the window shell — the header,
 * the pipeline trigger, the render loop and the popover sizing.
 */
import { formatUptime } from '../format-uptime.js';
import { lastComboboxInteractionAt } from '../combobox.js';
import { buildBranchSelector } from './branches.js';
import { rerenderTray } from './host.js';
import { icon, userIcon } from '../icon.js';
import type {
  ActionRuntimeState,
  CommandRuntimeState,
  GroupState,
} from '../../src/ipc-contract.js';
import type { Action, Command } from '../../src/domain-types.js';

// Expanded/collapsed state: groupId → boolean
const expandedState = new Map<string, boolean>();

// ─────────────────────── Group row ───────────────────────────────────

export function renderGroupRow(gs: GroupState): HTMLElement {
  const group = gs.group || {};
  const groupId = gs.groupId;
  const isExpanded = !!expandedState.get(groupId);

  const wrapper = document.createElement('div');
  wrapper.className = 'group-wrapper';
  wrapper.dataset.groupId = groupId;

  // ── Collapsed row ───────────────────────────────────────────────────
  const row = document.createElement('div');
  row.className = `group-row ${gs.color || 'stopped'}`;
  row.dataset.groupId = groupId;

  // Color dot
  const dot = document.createElement('span');
  dot.className = `dot ${gs.color || 'stopped'}`;
  row.appendChild(dot);

  // Group icon stays a plain label — it identifies the group, it is not a
  // control. Opening the logs gets its own terminal button further along.
  const groupIcon = document.createElement('span');
  groupIcon.className = 'group-icon';
  groupIcon.append(userIcon(group.icon, 'package', group.iconColor));
  row.appendChild(groupIcon);

  // Group name
  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.name || '(sin nombre)';
  row.appendChild(name);

  // Group-wide uptime: longest-running command in the group. Hidden when
  // nothing is running. Sits right after the name so the eye doesn't have
  // to hunt for it.
  const runningStarts = gs.commands
    .filter((command) => command.status === 'running')
    .map((command) => command.startedAt)
    .filter((startedAt): startedAt is number => startedAt !== null);
  if (runningStarts.length > 0) {
    const earliest = Math.min(...runningStarts);
    const uptime = document.createElement('span');
    uptime.className = 'uptime group-uptime';
    uptime.dataset.startedAt = String(earliest);
    uptime.textContent = formatUptime(Date.now() - earliest);
    row.appendChild(uptime);
  }

  // Error indicator
  if (gs.lastError) {
    const errBadge = document.createElement('span');
    errBadge.className = 'group-error-badge';
    errBadge.title = gs.lastError;
    errBadge.append(icon('x'));
    row.appendChild(errBadge);
  }

  // Spacer pushes the branch combobox to the right edge of the row.
  const spacer = document.createElement('span');
  spacer.className = 'group-row-spacer';
  row.appendChild(spacer);

  // Same icon as the per-command log buttons — one mark means "logs" at
  // every scope. The row itself toggles open, so this swallows its own click.
  const groupLogsBtn = document.createElement('button');
  groupLogsBtn.type = 'button';
  groupLogsBtn.className = 'ghost group-logs-btn';
  groupLogsBtn.append(icon('scroll-text'));
  groupLogsBtn.title = `Ver todos los logs de ${group.name || 'este grupo'}`;
  groupLogsBtn.setAttribute('aria-label', groupLogsBtn.title);
  groupLogsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void window.api.openLogs({ scope: 'group', groupId });
  });
  row.appendChild(groupLogsBtn);

  // Branch selector — always at the end of the row.
  const branchSel = buildBranchSelector(gs);
  row.appendChild(branchSel);

  // Expand chevron (only if group has actions or commands)
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'caret-btn ghost';
  caret.title = isExpanded ? 'Colapsar' : 'Expandir';
  caret.setAttribute('aria-label', caret.title);
  caret.setAttribute('aria-expanded', String(isExpanded));
  caret.append(icon(isExpanded ? 'chevron-down' : 'chevron-right'));
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    expandedState.set(groupId, !expandedState.get(groupId));
    rerenderTray();
  });
  row.appendChild(caret);

  // Row click → toggle expand/collapse, but ignore clicks on interactive children
  // (anything that already has its own click semantics, plus the uptime label
  // which the user may want to select-as-text without expanding the group).
  const INTERACTIVE_SELECTOR =
    '.combobox, .combobox-input, .combobox-list, .combobox-item, ' +
    '.caret-btn, .branch-select, .uptime, ' +
    'button, input, select, textarea, a';
  row.addEventListener('click', (e) => {
    if (
      e.target instanceof HTMLElement &&
      e.target.closest(INTERACTIVE_SELECTOR)
    )
      return;
    // When a combobox dropdown closes via selection, the browser synthesizes
    // a click on whatever is now under the cursor (the row, because the
    // dropdown — appended to document.body — just got display:none'd between
    // mousedown and mouseup). Ignore that synthetic click so we don't
    // re-render the tray mid-selection and orphan the combo's onSelect.
    if (
      lastComboboxInteractionAt() > 0 &&
      Date.now() - lastComboboxInteractionAt() < 250
    )
      return;
    expandedState.set(groupId, !expandedState.get(groupId));
    rerenderTray();
  });

  wrapper.appendChild(row);

  // ── Expanded section ─────────────────────────────────────────────────
  if (isExpanded) {
    const expanded = document.createElement('div');
    expanded.className = 'group-expanded';

    // Command list (for multi mode: each with individual start/stop)
    // For single mode already shown via picker, show here as additional detail
    if ((gs.commands || []).length > 0) {
      for (const cs of gs.commands) {
        const cmd = (group.commands || []).find((c) => c.id === cs.commandId);
        if (!cmd) continue;
        const subRow = buildCommandSubRow(gs, cs, cmd);
        expanded.appendChild(subRow);
      }
    }

    // Actions section
    if ((gs.actions || []).length > 0) {
      const actionsDivider = document.createElement('div');
      actionsDivider.className = 'actions-divider';
      // The rules either side are drawn by CSS (::before/::after).
      actionsDivider.textContent = 'Acciones';
      expanded.appendChild(actionsDivider);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'actions-row';
      for (const as of gs.actions) {
        const act = (group.actions || []).find((a) => a.id === as.actionId);
        if (!act) continue;
        const chip = buildActionChip(gs, as, act);
        actionsRow.appendChild(chip);
      }
      expanded.appendChild(actionsRow);
    }

    wrapper.appendChild(expanded);
  }

  return wrapper;
}

// ─────────────────────── Counter button helper ───────────────────────

/**
 * Build a clickable counter badge that opens filtered logs.
 * @param {'warn'|'error'} kind
 * @param {number} count
 * @param {string} processId
 */
function buildCounterBtn(
  kind: 'warn' | 'error',
  count: number,
  processId: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `counter-btn ${kind}`;
  btn.append(
    icon(kind === 'warn' ? 'triangle-alert' : 'circle-x'),
    ` ${count}`,
  );
  btn.title = `Ver logs filtrados por ${kind === 'warn' ? 'warnings' : 'errors'}`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // The same level chip as the in-window nav (the "sólo warnings" pill),
    // not a text search: every warn/error entry point behaves identically.
    window.api.openLogs({ processId, level: kind });
  });
  return btn;
}

// ─────────────────────── Command sub-row (expanded) ──────────────────

function buildCommandSubRow(
  gs: GroupState,
  cs: CommandRuntimeState,
  cmd: Command,
): HTMLElement {
  const subRow = document.createElement('div');
  subRow.className = 'cmd-sub-row';

  const dot = document.createElement('span');
  dot.className = `dot ${cs.color || 'stopped'}`;
  subRow.appendChild(dot);

  if (cmd.icon) {
    const cmdIconEl = document.createElement('span');
    cmdIconEl.className = 'cmd-sub-icon';
    cmdIconEl.append(userIcon(cmd.icon, 'terminal', cmd.iconColor));
    subRow.appendChild(cmdIconEl);
  }

  const cmdName = document.createElement('span');
  cmdName.className = 'cmd-sub-name';
  cmdName.textContent = cmd.name;
  subRow.appendChild(cmdName);

  if (cs.warnCount > 0 || cs.errorCount > 0) {
    const counters = document.createElement('span');
    counters.className = 'cmd-counters';
    if (!cs.muteWarn && cs.warnCount > 0) {
      const w = buildCounterBtn('warn', cs.warnCount, cs.processId);
      counters.appendChild(w);
    }
    if (!cs.muteErr && cs.errorCount > 0) {
      const e = buildCounterBtn('error', cs.errorCount, cs.processId);
      counters.appendChild(e);
    }
    subRow.appendChild(counters);
  }

  // Uptime label — only when running
  if (cs.status === 'running' && cs.startedAt) {
    const uptimeEl = document.createElement('span');
    uptimeEl.className = 'uptime';
    uptimeEl.dataset.startedAt = String(cs.startedAt);
    uptimeEl.textContent = formatUptime(Date.now() - cs.startedAt);
    subRow.appendChild(uptimeEl);
  }

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  subRow.appendChild(spacer);

  // Logs button
  const logsBtn = document.createElement('button');
  logsBtn.type = 'button';
  logsBtn.className = 'ghost cmd-sub-btn';
  logsBtn.title = 'Ver logs';
  logsBtn.setAttribute('aria-label', logsBtn.title);
  logsBtn.append(icon('scroll-text'));
  logsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.openLogs(cs.processId);
  });
  subRow.appendChild(logsBtn);

  // Auto-start toggle button. Accent when autoStart is on; muted when off.
  const autoStartBtn = document.createElement('button');
  autoStartBtn.type = 'button';
  autoStartBtn.className = `ghost cmd-sub-btn autostart-btn${cmd.autoStart ? ' autostart-on' : ''}`;
  autoStartBtn.title = 'Auto-arrancar al iniciar DevBar';
  autoStartBtn.setAttribute('aria-label', autoStartBtn.title);
  autoStartBtn.setAttribute('aria-pressed', String(!!cmd.autoStart));
  autoStartBtn.append(icon('zap'));
  autoStartBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    autoStartBtn.disabled = true;
    await window.api.setCommandAutoStart(gs.groupId, cmd.id, !cmd.autoStart);
    autoStartBtn.disabled = false;
    // The broadcast from main will trigger a full re-render.
  });
  subRow.appendChild(autoStartBtn);

  // Start/stop button
  const isRunning = cs.status === 'running';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `ghost cmd-sub-btn ${isRunning ? 'stop-btn' : 'start-btn'}`;
  toggle.append(icon(isRunning ? 'square' : 'play'));
  toggle.title = isRunning ? 'Detener' : 'Iniciar';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.addEventListener('click', async (e) => {
    e.stopPropagation();
    toggle.disabled = true;
    if (isRunning) {
      await window.api.stopProcess(cs.processId);
    } else {
      await window.api.startProcess(cs.processId);
    }
    toggle.disabled = false;
  });
  subRow.appendChild(toggle);

  return subRow;
}

// ─────────────────────── Action chip ─────────────────────────────────

function buildActionChip(
  gs: GroupState,
  actionState: ActionRuntimeState,
  act: Action,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'action-chip-wrap';

  const chip = document.createElement('button');
  const isRunning = actionState.status === 'running';
  const isDone = actionState.status === 'done';

  chip.className = `action-chip ${isRunning ? 'running' : ''} ${isDone ? 'done' : ''}`;
  chip.title = `${act.name}${actionState.lastExitCode !== null ? ` (exit ${actionState.lastExitCode})` : ''}`;

  // Icon + name, then the outcome of the last run while it is fresh.
  if (act.icon) chip.append(userIcon(act.icon, 'wand-sparkles', act.iconColor));
  if (isRunning) {
    chip.append(`${act.name} …`);
  } else if (
    isDone &&
    !(
      actionState.lastFinishedAt &&
      Date.now() - actionState.lastFinishedAt > 4000
    )
  ) {
    chip.append(act.name, icon(actionState.lastExitCode === 0 ? 'check' : 'x'));
  } else {
    // Idle, or a done status old enough to fade back to a plain chip.
    chip.className = 'action-chip';
    chip.append(act.name);
  }

  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isRunning) return;
    chip.disabled = true;
    await window.api.runAction(gs.groupId, act.id);
    chip.disabled = false;
  });
  wrap.appendChild(chip);

  // Once an action has run, its output stays in the log buffer — expose it so
  // it can be reviewed after the fact (manual or scheduled runs alike).
  const hasLog = isRunning || actionState.lastFinishedAt != null;
  if (hasLog && actionState.processId) {
    const logsBtn = document.createElement('button');
    logsBtn.type = 'button';
    logsBtn.className = 'ghost action-logs-btn';
    logsBtn.title = 'Ver log de la acción';
    logsBtn.setAttribute('aria-label', logsBtn.title);
    logsBtn.append(icon('scroll-text'));
    logsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.openLogs(actionState.processId);
    });
    wrap.appendChild(logsBtn);
  }

  return wrap;
}
