import { formatUptime } from './format-uptime.js';
import { isComboboxOpen, setComboboxHostHooks } from './combobox.js';
import type {
  GroupState,
  PipelineState,
  UpdateStatus,
} from '../src/ipc-contract.js';
import { byId } from './dom.js';
import { clearBranchCache } from './tray/branches.js';
import { renderGroupRow } from './tray/group-row.js';
import { setTrayHost, showToast } from './tray/host.js';
import { latestWins } from './latest-wins.js';
import { installTooltips } from './tooltip.js';
import { initTheme } from './theme.js';
initTheme();
const groupsEl = byId('groups', HTMLElement);
const toastEl = byId('toast', HTMLElement);

// ─────────────────────── Uptime ticker ───────────────────────────────

/**
 * Walk all .uptime[data-started-at] elements and refresh their text.
 * Called every second by the interval below.
 */
function updateUptimes() {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>(
    '.uptime[data-started-at]',
  )) {
    const startedAt = parseInt(el.dataset.startedAt ?? '', 10);
    if (!startedAt) continue;
    el.textContent = formatUptime(now - startedAt);
  }
}

// Single top-level interval — never accumulates
let _uptimeInterval: ReturnType<typeof setInterval> | null = null;
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
let lastGroupStates: GroupState[] = [];
// State update that arrived while a branch dropdown was open; replayed on close.
let _pendingStates: GroupState[] | null = null;

// ─────────────────────── Alerts summary ─────────────────────────────

function renderAlertsSummary(groupStates: GroupState[]): void {
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
  summary.textContent = '';
  // The totals across every group — pressing one opens the generic telemetry
  // view already pinned to that level.
  if (warns > 0)
    summary.appendChild(
      alertButton('warn', `⚠ ${warns}`, `Ver los ${warns} warning(s) de todo`),
    );
  if (errs > 0)
    summary.appendChild(
      alertButton('error', `✕ ${errs}`, `Ver los ${errs} error(es) de todo`),
    );
}

function alertButton(
  level: 'warn' | 'error',
  label: string,
  title: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = level === 'warn' ? 'warn-count' : 'error-count';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', () => {
    void window.api.openLogs({ scope: 'all', level });
  });
  return btn;
}

// ─────────────────────── Global pipeline trigger ──────────────────────
//
// One global `▶▶` trigger/badge/cancel-chip/logs-button, replacing the
// per-group ones (there is one pipeline now, not one per group). Rendered
// once in the sticky header, not per group row.

let lastPipelineState: PipelineState | null = null;

function renderPipelineTrigger(state: PipelineState | null): void {
  lastPipelineState = state;
  const host = document.getElementById('pipeline-trigger');
  if (!host) return;
  host.innerHTML = '';
  // Nothing configured and nothing to show for a past run — hide entirely,
  // same gate as the old per-group "only when preSteps defined" condition.
  if (!state || (state.totalSteps === 0 && state.status === 'idle')) return;

  const triggerBtn = document.createElement('button');
  triggerBtn.className = 'ghost prescripts-trigger';
  triggerBtn.title =
    state.status === 'running' ? 'Pipeline corriendo…' : 'Ejecutar pipeline';
  triggerBtn.dataset.prestepStatus = state.status;
  triggerBtn.textContent = '▶▶';
  triggerBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (state.status === 'running') {
      showToast('Ya hay un pipeline corriendo', 'warn');
      return;
    }
    const res = await window.api.runPreScripts();
    if (res && !res.ok && res.error === 'already_running') {
      showToast('Ya hay un pipeline corriendo', 'warn');
    }
  });
  host.appendChild(triggerBtn);

  // Status badge — compact, responsive: hide "paso N/M" when redundant
  // (single-step pipelines) and drop the word "paso" for multi-step. Full
  // info lives in the tooltip so the header never gets squeezed by the
  // badge regardless of how long the pipeline runs.
  if (state.status === 'running') {
    const badge = document.createElement('span');
    badge.className = 'prestep-badge';
    const total = state.totalSteps || 1;
    const current = state.currentStep || 1;
    const showStep = total > 1;
    badge.title = `Pipeline: paso ${current}/${total}`;

    if (showStep) {
      const stepSpan = document.createElement('span');
      stepSpan.className = 'prestep-step';
      stepSpan.textContent = `${current}/${total}`;
      badge.appendChild(stepSpan);
    }

    if (state.startedAt) {
      if (showStep) badge.appendChild(document.createTextNode(' · '));
      const elapsedSpan = document.createElement('span');
      elapsedSpan.className = 'uptime prestep-elapsed';
      elapsedSpan.dataset.startedAt = String(state.startedAt);
      elapsedSpan.textContent = formatUptime(Date.now() - state.startedAt);
      badge.appendChild(elapsedSpan);
    }

    host.appendChild(badge);

    const cancelChip = document.createElement('button');
    cancelChip.className = 'ghost prestep-cancel';
    cancelChip.title = 'Cancelar pipeline';
    cancelChip.textContent = '×';
    cancelChip.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.cancelPreScripts();
    });
    host.appendChild(cancelChip);
  } else if (state.status === 'done') {
    const badge = document.createElement('span');
    badge.className = 'prestep-badge ok';
    badge.textContent = '✓';
    host.appendChild(badge);
  } else if (state.status === 'error') {
    const badge = document.createElement('span');
    badge.className = 'prestep-badge err';
    badge.title = state.lastError || 'Error en el pipeline';
    badge.textContent = '✕';
    host.appendChild(badge);
  }

  // Log opener — shown whenever a run's log exists (it persists after the
  // transient status badge clears), so a finished pipeline stays reviewable.
  if (state.lastRunId) {
    const logsBtn = document.createElement('button');
    logsBtn.className = 'ghost prestep-logs-btn';
    logsBtn.title = 'Ver logs del pipeline';
    logsBtn.textContent = '📋';
    logsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.openLogs(`pre-pipeline:${state.lastRunId}`);
    });
    host.appendChild(logsBtn);
  }
}

// ─────────────────────── Main render ─────────────────────────────────

/**
 * Render every group row from the given state and resize the tray to fit.
 * While a branch dropdown is open the rebuild is deferred (see guard) because
 * wiping the list would detach the live combobox mid-interaction.
 * @param {Array} groupStates - per-group view state from the main process
 */
function render(groupStates: GroupState[]): void {
  lastGroupStates = groupStates;
  // A branch dropdown is open: wiping the groups list here would destroy the
  // combobox mid-interaction and orphan its (body-level) dropdown, while the
  // resize below would shrink the popover under it. Defer until it closes.
  if (isComboboxOpen()) {
    _pendingStates = groupStates;
    return;
  }
  groupsEl.innerHTML = '';
  renderAlertsSummary(groupStates);
  renderPipelineTrigger(lastPipelineState);

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
function measureContentHeight(): number {
  const header = document.querySelector<HTMLElement>('.tray-header');
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
/**
 * Resize the tray window to its natural content height, debounced to one
 * animation frame. No-ops while a dropdown is open (the combobox owns the
 * height then); closeList() re-runs it once the dropdown count hits 0.
 */
function scheduleTrayResize(): void {
  if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
  _resizeRaf = requestAnimationFrame(() => {
    _resizeRaf = 0;
    // While a dropdown is open the combobox owns the height (requestHostHeight
    // grows to fit it); shrinking here would clip it. closeList() re-runs this
    // once the count hits 0.
    if (isComboboxOpen()) return;
    if (!window.api || !window.api.setTrayHeight) return;
    window.api.setTrayHeight(measureContentHeight());
  });
}
/** Replay a state update that was deferred while a dropdown was open. */
function flushPendingRender(): void {
  if (!_pendingStates) return;
  const states = _pendingStates;
  _pendingStates = null;
  render(states);
}
setComboboxHostHooks({
  flushPendingRender,
  scheduleTrayResize,
  measureContentHeight,
});
setTrayHost({
  toastElement: toastEl,
  rerender: () => render(lastGroupStates),
});

// ─────────────────────── Event wiring ────────────────────────────────

byId('open-telemetry', HTMLButtonElement).addEventListener('click', () => {
  void window.api.openLogs({ scope: 'all' });
});
byId('open-config', HTMLButtonElement).addEventListener('click', () => {
  window.api.openConfig();
});
byId('quit-app', HTMLButtonElement).addEventListener('click', () => {
  window.api.quit();
});

let lastPathSignature = '';
const pushedGroupStates = latestWins();
window.api.onUpdate((groupStates) => {
  // This pushed snapshot is now the truth: the initial read below may still
  // be in flight, and it carries an older one.
  pushedGroupStates.invalidate();
  // A group's path moving (added, retargeted, cleared) invalidates every
  // branch verdict — including "this project has no git" — so the selector
  // reappears as soon as the project becomes a repository.
  const signature = groupStates
    .map((gs) => `${gs.groupId}:${gs.group?.path ?? ''}`)
    .sort()
    .join('|');
  if (signature !== lastPathSignature) {
    lastPathSignature = signature;
    clearBranchCache(groupStates.map((gs) => gs.groupId));
  }
  render(groupStates);
});

window.api.onPipelineUpdate((state) => {
  renderPipelineTrigger(state);
});

window.api.onBranchesChanged(() => {
  if (lastGroupStates.length) {
    clearBranchCache(lastGroupStates.map((gs) => gs.groupId));
    render(lastGroupStates);
  }
});

window.api.onToast(({ kind, message }) => {
  showToast(message, kind);
});

// Initial load
const initialGroupStates = pushedGroupStates.claim();
window.api.getGroupStates().then((groupStates) => {
  // A pushed update can land while this read is still pending; applying the
  // older snapshot on top would leave the list stale until the next push.
  if (initialGroupStates()) render(groupStates);
});
window.api.getPipelineState().then((state) => {
  // A pushed update can land while this read is still pending; applying the
  // older snapshot on top would leave the trigger stale until the next push.
  if (lastPipelineState === null) renderPipelineTrigger(state);
});

// App version label
if (window.api.getAppVersion) {
  window.api
    .getAppVersion()
    .then((v) => {
      const el = document.getElementById('app-version');
      if (el && v) {
        el.textContent = `v${v}`;
        // The popover is too small for the modal — open config on "Acerca de"
        // with the changelog instead.
        el.addEventListener('click', () => window.api.openConfigChangelog());
      }
    })
    .catch(() => {
      /* leave span empty on failure */
    });
}

// A pending update puts a small red dot on the version chip — same cue as the
// menubar mark and the one in config, so the user knows where to click.
function markVersionUpdate(status: UpdateStatus): void {
  const el = document.getElementById('app-version');
  if (!el) return;
  const version = status && status.available ? status.available.version : null;
  el.classList.toggle('has-update', !!version);
  el.title = version
    ? `v${version} disponible — ver changelog`
    : 'Ver changelog';
}

if (window.api.getUpdateStatus) {
  const pushedUpdateStatus = latestWins();
  const initialUpdateStatus = pushedUpdateStatus.claim();
  window.api
    .getUpdateStatus()
    .then((status) => {
      // Same race as the group states: a pushed status that landed first
      // would be undone here, dropping the dot from the version chip until
      // the next check hours later.
      if (initialUpdateStatus()) markVersionUpdate(status);
    })
    .catch(() => {});
  window.api.onUpdateStatus((status) => {
    pushedUpdateStatus.invalidate();
    markVersionUpdate(status);
  });
}

installTooltips();
