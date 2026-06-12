'use strict';

const groupsEl = document.getElementById('groups');
const toastEl = document.getElementById('toast');


// ─────────────────────── Uptime ticker ───────────────────────────────

/**
 * Walk all .uptime[data-started-at] elements and refresh their text.
 * Called every second by the interval below.
 */
function updateUptimes() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.uptime[data-started-at]')) {
    const startedAt = parseInt(el.dataset.startedAt, 10);
    if (!startedAt) continue;
    el.textContent = formatUptime(now - startedAt);
  }
}

// Single top-level interval — never accumulates
let _uptimeInterval = null;
document.addEventListener('DOMContentLoaded', () => {
  if (_uptimeInterval) clearInterval(_uptimeInterval);
  _uptimeInterval = setInterval(updateUptimes, 1000);
});
// Also start immediately in case DOMContentLoaded already fired (script at end of body)
if (document.readyState !== 'loading') {
  if (_uptimeInterval) clearInterval(_uptimeInterval);
  _uptimeInterval = setInterval(updateUptimes, 1000);
}

// Keyed by groupId
let lastGroupStates = [];
// Branch cache: groupId → { branches: string[], current: string|null }
const branchCache = new Map();
// Expanded/collapsed state: groupId → boolean
const expandedState = new Map();

// ─────────────────────── Toast ───────────────────────────────────────

function showToast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.style.display = 'none';
  }, 4000);
}

// ─────────────────────── Alerts summary ─────────────────────────────

function renderAlertsSummary(groupStates) {
  const summary = document.getElementById('alerts-summary');
  if (!summary) return;
  let warns = 0;
  let errs = 0;
  for (const gs of groupStates) {
    for (const cs of gs.commands || []) {
      if (cs.status !== 'running') continue;
      if (!cs.muteWarn) warns += cs.warnCount;
      if (!cs.muteErr) errs += cs.errorCount;
    }
  }
  if (warns === 0 && errs === 0) {
    summary.textContent = '';
    summary.style.display = 'none';
    return;
  }
  summary.style.display = '';
  summary.innerHTML =
    (warns > 0 ? `<span class="warn-count">⚠ ${warns}</span>` : '') +
    (errs > 0 ? `<span class="error-count" style="margin-left:8px">✕ ${errs}</span>` : '');
}

// ─────────────────────── Main render ─────────────────────────────────

function render(groupStates) {
  lastGroupStates = groupStates;
  groupsEl.innerHTML = '';
  renderAlertsSummary(groupStates);

  if (!groupStates.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML =
      'No hay grupos configurados.<br/>Pulsa <strong>Configuración</strong> para añadir uno.';
    groupsEl.appendChild(empty);
    scheduleTrayResize();
    return;
  }

  for (const gs of groupStates) {
    groupsEl.appendChild(renderGroupRow(gs));
  }
  scheduleTrayResize();
}

// ─────────────────────── Dynamic popover height ──────────────────────

/**
 * Measure the natural height of the tray content.
 *
 * The two pieces of chrome are the sticky header and the groups list.
 * `.groups-list` has overflow-y: auto so it can scroll internally if
 * the popover ever hits the screen cap; that means we CANNOT rely on
 * getBoundingClientRect (which reports the clipped layout box) or on
 * body.scrollHeight (which reflects max(viewport, content) once the
 * BrowserWindow has been sized — one-way grow).
 *
 * Instead we ask the groups container directly for its `scrollHeight`,
 * which is the real un-clipped content height. Add the header's box
 * and the body's vertical padding and we have the deterministic value.
 */
function measureContentHeight() {
  const header = document.querySelector('.tray-header');
  const groups = document.getElementById('groups');
  if (!groups) return 0;
  const bodyCS = getComputedStyle(document.body);
  const padTop = parseFloat(bodyCS.paddingTop) || 0;
  const padBottom = parseFloat(bodyCS.paddingBottom) || 0;
  let headerBlock = 0;
  if (header) {
    const headerCS = getComputedStyle(header);
    const mt = parseFloat(headerCS.marginTop) || 0;
    const mb = parseFloat(headerCS.marginBottom) || 0;
    headerBlock = header.offsetHeight + mt + mb;
  }
  return Math.ceil(padTop + headerBlock + groups.scrollHeight + padBottom);
}

let _resizeRaf = 0;
function scheduleTrayResize() {
  if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
  _resizeRaf = requestAnimationFrame(() => {
    _resizeRaf = 0;
    if (!window.api || !window.api.setTrayHeight) return;
    window.api.setTrayHeight(measureContentHeight());
  });
}
// Exposed so the branch combobox (which lives in its own module and
// inflates the popover when opened) can request a shrink-back when
// it closes.
window.__scheduleTrayResize = scheduleTrayResize;

// ─────────────────────── Group row ───────────────────────────────────

function renderGroupRow(gs) {
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

  // Group icon
  const icon = document.createElement('span');
  icon.className = 'group-icon';
  icon.textContent = group.icon || '📦';
  row.appendChild(icon);

  // Group name
  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.name || '(sin nombre)';
  row.appendChild(name);

  // Group-wide uptime: longest-running command in the group. Hidden when
  // nothing is running. Sits right after the name so the eye doesn't have
  // to hunt for it.
  const runningCmds = (gs.commands || []).filter(
    (c) => c.status === 'running' && c.startedAt,
  );
  if (runningCmds.length > 0) {
    const earliest = runningCmds.reduce(
      (acc, c) => (acc.startedAt < c.startedAt ? acc : c),
      runningCmds[0],
    );
    const uptime = document.createElement('span');
    uptime.className = 'uptime group-uptime';
    uptime.dataset.startedAt = String(earliest.startedAt);
    uptime.textContent = formatUptime(Date.now() - earliest.startedAt);
    row.appendChild(uptime);
  }

  // Error indicator
  if (gs.lastError) {
    const errBadge = document.createElement('span');
    errBadge.className = 'group-error-badge';
    errBadge.title = gs.lastError;
    errBadge.textContent = '✕';
    row.appendChild(errBadge);
  }

  // Spacer pushes the branch combobox to the right edge of the row.
  const spacer = document.createElement('span');
  spacer.className = 'group-row-spacer';
  row.appendChild(spacer);

  // Branch selector — always at the end of the row.
  const branchSel = buildBranchSelector(gs);
  row.appendChild(branchSel);

  // Pre-scripts trigger — only shown when the group has preSteps defined.
  if ((group.preSteps || []).length > 0) {
    const prescriptStatus = gs.preScriptsStatus || 'idle';

    // ▶▶ trigger button
    const prescriptsBtn = document.createElement('button');
    prescriptsBtn.className = 'ghost prescripts-trigger';
    prescriptsBtn.title = prescriptStatus === 'running'
      ? 'Pre-scripts corriendo…'
      : 'Ejecutar pre-scripts';
    prescriptsBtn.dataset.prestepStatus = prescriptStatus;
    prescriptsBtn.textContent = '▶▶';
    prescriptsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (prescriptStatus === 'running') {
        showToast('Ya hay un pipeline corriendo', 'warn');
        return;
      }
      const res = await window.api.runPreScripts(groupId);
      if (res && !res.ok && res.error === 'already_running') {
        showToast('Ya hay un pipeline corriendo', 'warn');
      }
    });
    row.appendChild(prescriptsBtn);

    // Status badge — compact, responsive: hide "paso N/M" when redundant
    // (single-step pipelines) and drop the word "paso" for multi-step.
    // Full info lives in the tooltip so the row never gets squeezed by the
    // badge regardless of how long the pipeline runs.
    if (prescriptStatus === 'running') {
      const badge = document.createElement('span');
      badge.className = 'prestep-badge';
      const total = gs.preScriptsTotalSteps || 1;
      const current = gs.preScriptsCurrentStep || 1;
      const showStep = total > 1;
      badge.title = `Pre-scripts: paso ${current}/${total}`;

      if (showStep) {
        const stepSpan = document.createElement('span');
        stepSpan.className = 'prestep-step';
        stepSpan.textContent = `${current}/${total}`;
        badge.appendChild(stepSpan);
      }

      if (gs.preScriptsStartedAt) {
        if (showStep) badge.appendChild(document.createTextNode(' · '));
        const elapsedSpan = document.createElement('span');
        elapsedSpan.className = 'uptime prestep-elapsed';
        elapsedSpan.dataset.startedAt = String(gs.preScriptsStartedAt);
        elapsedSpan.textContent = formatUptime(Date.now() - gs.preScriptsStartedAt);
        badge.appendChild(elapsedSpan);
      }

      row.appendChild(badge);

      const cancelChip = document.createElement('button');
      cancelChip.className = 'ghost prestep-cancel';
      cancelChip.title = 'Cancelar pre-scripts';
      cancelChip.textContent = '×';
      cancelChip.addEventListener('click', (e) => {
        e.stopPropagation();
        window.api.cancelPreScripts(groupId);
      });
      row.appendChild(cancelChip);

      // Logs opener for the aggregator pid (shows pipeline boundary lines)
      if (gs.preScriptsLastRunId) {
        const logsBtn = document.createElement('button');
        logsBtn.className = 'ghost prestep-logs-btn';
        logsBtn.title = 'Ver logs del pipeline';
        logsBtn.textContent = '📋';
        logsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.openLogs(`pre-pipeline:${groupId}:${gs.preScriptsLastRunId}`);
        });
        row.appendChild(logsBtn);
      }
    } else if (prescriptStatus === 'done') {
      const badge = document.createElement('span');
      badge.className = 'prestep-badge ok';
      badge.textContent = '✓';
      row.appendChild(badge);

      // Still allow opening logs for the last run
      if (gs.preScriptsLastRunId) {
        const logsBtn = document.createElement('button');
        logsBtn.className = 'ghost prestep-logs-btn';
        logsBtn.title = 'Ver logs del pipeline';
        logsBtn.textContent = '📋';
        logsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.openLogs(`pre-pipeline:${groupId}:${gs.preScriptsLastRunId}`);
        });
        row.appendChild(logsBtn);
      }
    } else if (prescriptStatus === 'error') {
      const badge = document.createElement('span');
      badge.className = 'prestep-badge err';
      badge.title = gs.preScriptsLastError || 'Error en el pipeline';
      badge.textContent = '✕';
      row.appendChild(badge);

      // Still allow opening logs for the last run
      if (gs.preScriptsLastRunId) {
        const logsBtn = document.createElement('button');
        logsBtn.className = 'ghost prestep-logs-btn';
        logsBtn.title = 'Ver logs del pipeline';
        logsBtn.textContent = '📋';
        logsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.openLogs(`pre-pipeline:${groupId}:${gs.preScriptsLastRunId}`);
        });
        row.appendChild(logsBtn);
      }
    }
  }

  // Expand chevron (only if group has actions or commands)
  const caret = document.createElement('button');
  caret.className = 'caret-btn ghost';
  caret.title = isExpanded ? 'Colapsar' : 'Expandir';
  caret.textContent = isExpanded ? '▾' : '▸';
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    expandedState.set(groupId, !expandedState.get(groupId));
    render(lastGroupStates);
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
    if (e.target.closest(INTERACTIVE_SELECTOR)) return;
    // When a combobox dropdown closes via selection, the browser synthesizes
    // a click on whatever is now under the cursor (the row, because the
    // dropdown — appended to document.body — just got display:none'd between
    // mousedown and mouseup). Ignore that synthetic click so we don't
    // re-render the tray mid-selection and orphan the combo's onSelect.
    if (window.__comboboxSelectingAt && Date.now() - window.__comboboxSelectingAt < 250) return;
    expandedState.set(groupId, !expandedState.get(groupId));
    render(lastGroupStates);
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
      actionsDivider.textContent = '── Acciones ──';
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

// ─────────────────────── Branch selector (combobox) ──────────────────

function buildBranchSelector(gs) {
  const groupId = gs.groupId;
  const group = gs.group || {};

  // Groups without a path don't have branches
  if (!group.path) {
    const placeholder = document.createElement('span');
    placeholder.className = 'branch-select';
    placeholder.style.cssText = 'font-size:11px; color:var(--muted); flex-shrink:0; padding:2px 4px;';
    placeholder.textContent = 'Rama…';
    return placeholder;
  }

  const cached = branchCache.get(groupId);
  const initOptions = cached ? branchDataToOptions(cached) : [];
  const initValue = cached ? (cached.current || null) : null;

  const combo = createCombobox({
    value: initValue,
    options: initOptions,
    placeholder: cached ? 'Rama…' : 'Cargando…',
    onSelect: async (branch) => {
      if (!branch) return;
      combo.setLoading(true);
      const res = await window.api.switchBranch(groupId, branch);
      combo.setLoading(false);
      branchCache.delete(groupId);
      if (!res.ok) {
        showToast(`${group.name}: ${(res.error || '').split('\n')[0]}`, 'error');
        // Reload branches to restore correct state
        loadBranchesIntoCombo(groupId, combo);
      } else {
        showToast(`${group.name} → ${branch}`, 'ok');
        // Update cache and combo without full re-render
        loadBranchesIntoCombo(groupId, combo);
      }
    },
  });

  // If no cache, load branches asynchronously
  if (!cached) {
    combo.setLoading(true);
    loadBranchesIntoCombo(groupId, combo);
  }

  return combo;
}

function branchDataToOptions(data) {
  return (data.branches || []).map((b) => ({
    value: b,
    label: b,
    current: data.current === b,
  }));
}

function loadBranchesIntoCombo(groupId, combo) {
  window.api.listBranches(groupId).then((res) => {
    combo.setLoading(false);
    if (!res.ok) return;
    window.api.currentBranch(groupId).then((cur) => {
      const data = { branches: res.branches, current: cur.ok ? cur.branch : null };
      branchCache.set(groupId, data);
      combo.setOptions(branchDataToOptions(data));
      combo.setValue(data.current || null);
    });
  });
}

// ─────────────────────── Counter button helper ───────────────────────

/**
 * Build a clickable counter badge that opens filtered logs.
 * @param {'warn'|'error'} kind
 * @param {number} count
 * @param {string} processId
 * @param {string} filterRegex  — passed as filter to openLogs
 */
function buildCounterBtn(kind, count, processId, filterRegex) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `counter-btn ${kind}`;
  btn.textContent = kind === 'warn' ? `⚠ ${count}` : `✕ ${count}`;
  btn.title = `Ver logs filtrados por ${kind === 'warn' ? 'warnings' : 'errors'}`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.openLogs({ processId, filter: filterRegex });
  });
  return btn;
}

// ─────────────────────── Command sub-row (expanded) ──────────────────

function buildCommandSubRow(gs, cs, cmd) {
  const subRow = document.createElement('div');
  subRow.className = 'cmd-sub-row';

  const dot = document.createElement('span');
  dot.className = `dot ${cs.color || 'stopped'}`;
  subRow.appendChild(dot);

  if (cmd.icon) {
    const cmdIconEl = document.createElement('span');
    cmdIconEl.className = 'cmd-sub-icon';
    cmdIconEl.textContent = cmd.icon;
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
      const w = buildCounterBtn('warn', cs.warnCount, cs.processId, '\\bwarn(ing)?s?\\b');
      counters.appendChild(w);
    }
    if (!cs.muteErr && cs.errorCount > 0) {
      const e = buildCounterBtn('error', cs.errorCount, cs.processId, '\\berror(s)?\\b');
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
  logsBtn.className = 'ghost cmd-sub-btn';
  logsBtn.title = 'Ver logs';
  logsBtn.textContent = '📜';
  logsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.openLogs(cs.processId);
  });
  subRow.appendChild(logsBtn);

  // Auto-start toggle button (⚡)
  // Filled accent when autoStart is on; muted outline when off.
  const autoStartBtn = document.createElement('button');
  autoStartBtn.className = `ghost cmd-sub-btn autostart-btn${cmd.autoStart ? ' autostart-on' : ''}`;
  autoStartBtn.title = 'Auto-arrancar al iniciar DevBar';
  autoStartBtn.textContent = '⚡';
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
  toggle.className = `ghost cmd-sub-btn ${isRunning ? 'stop-btn' : 'start-btn'}`;
  toggle.textContent = isRunning ? '■' : '▶';
  toggle.title = isRunning ? 'Detener' : 'Iniciar';
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

function buildActionChip(gs, as, act) {
  const chip = document.createElement('button');
  const isRunning = as.status === 'running';
  const isDone = as.status === 'done';

  chip.className = `action-chip ${isRunning ? 'running' : ''} ${isDone ? 'done' : ''}`;
  chip.title = `${act.name}${as.lastExitCode !== null ? ` (exit ${as.lastExitCode})` : ''}`;

  // Icon + name
  const iconPart = act.icon ? `${act.icon} ` : '';
  if (isRunning) {
    chip.textContent = `${iconPart}${act.name} …`;
  } else if (isDone) {
    const exitOk = as.lastExitCode === 0;
    chip.textContent = `${iconPart}${act.name} ${exitOk ? '✓' : '✕'}`;
    // Clear done status after a few seconds
    if (as.lastFinishedAt && Date.now() - as.lastFinishedAt > 4000) {
      chip.className = 'action-chip';
      chip.textContent = `${iconPart}${act.name}`;
    }
  } else {
    chip.textContent = `${iconPart}${act.name}`;
  }

  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isRunning) return;
    chip.disabled = true;
    await window.api.runAction(gs.groupId, act.id);
    chip.disabled = false;
  });

  return chip;
}

// ─────────────────────── Event wiring ────────────────────────────────

document.getElementById('open-config').addEventListener('click', () => {
  window.api.openConfig();
});
document.getElementById('quit-app').addEventListener('click', () => {
  window.api.quit();
});

window.api.onUpdate((groupStates) => {
  render(groupStates);
});

window.api.onBranchesChanged(() => {
  branchCache.clear();
  if (lastGroupStates.length) render(lastGroupStates);
});

window.api.onToast(({ kind, message }) => {
  showToast(message, kind);
});

// Initial load
window.api.getGroupStates().then((groupStates) => {
  render(groupStates);
});

// App version label
if (window.api.getAppVersion) {
  window.api.getAppVersion()
    .then((v) => {
      const el = document.getElementById('app-version');
      if (el && v) el.textContent = `v${v}`;
    })
    .catch(() => { /* leave span empty on failure */ });
}
