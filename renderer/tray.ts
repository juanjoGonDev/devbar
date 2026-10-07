import './report-uncaught.js';
import { formatUptime } from './format-uptime.js';
import { isComboboxOpen, setComboboxHostHooks } from './combobox.js';
import type { GroupState, PipelineState } from '../src/ipc-contract.js';
import { byId } from './dom.js';
import { clearBranchCache } from './tray/branches.js';
import { renderGroupRow } from './tray/group-row.js';
import { setTrayHost, showToast } from './tray/host.js';
import { wireUpdateChip } from './tray/update-chip.js';
import { renderPipelineStrip } from './tray/pipeline-strip.js';
import { installAutoHeight } from './tray/auto-height.js';
import { latestWins } from './latest-wins.js';
import { installTooltips } from './tooltip.js';
import { initTheme } from './theme.js';
import { hydrateIcons, icon } from './icon.js';
import { watchCustomIcons } from './custom-icons.js';
initTheme();
hydrateIcons(document);
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
      alertButton('warn', warns, `Ver los ${warns} warning(s) de todo`),
    );
  if (errs > 0)
    summary.appendChild(
      alertButton('error', errs, `Ver los ${errs} error(es) de todo`),
    );
}

function alertButton(
  level: 'warn' | 'error',
  count: number,
  title: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = level === 'warn' ? 'warn-count' : 'error-count';
  btn.append(
    icon(level === 'warn' ? 'triangle-alert' : 'circle-x'),
    ` ${count}`,
  );
  btn.title = title;
  btn.addEventListener('click', () => {
    void window.api.openLogs({ scope: 'all', level });
  });
  return btn;
}

// ─────────────────────── Global pipeline trigger ──────────────────────
//
// One global run-pipeline trigger in the sticky header row (there is one
// pipeline now, not one per group). Everything about a run — step, elapsed
// time, cancel, logs, the ✓/✕ result — lives in the pipeline strip under the
// row (renderer/tray/pipeline-strip.ts).

let lastPipelineState: PipelineState | null = null;

function renderPipelineTrigger(state: PipelineState | null): void {
  lastPipelineState = state;
  renderPipelineStrip(state);
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
  triggerBtn.setAttribute('aria-label', triggerBtn.title);
  triggerBtn.dataset.prestepStatus = state.status;
  triggerBtn.append(icon('fast-forward'));
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
    autoHeight.schedule();
    return;
  }

  for (const gs of groupStates) {
    groupsEl.appendChild(renderGroupRow(gs));
  }
  autoHeight.schedule();
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

// Every DOM change in the popover — a state render, a row expanding, the
// update chip, a banner — re-measures on the next frame, so the height
// follows the content while the popover is open. While a dropdown is open the
// combobox owns the height (requestHostHeight grows to fit it); closeList()
// forces a resend once the count hits 0, which shrinks the window back.
const autoHeight = installAutoHeight({
  root: document.body,
  measure: measureContentHeight,
  send: (height) => {
    if (window.api?.setTrayHeight) void window.api.setTrayHeight(height);
  },
  isSuspended: isComboboxOpen,
});
/** Re-measures on the next frame and resends even an unchanged height. */
function scheduleTrayResize(): void {
  autoHeight.schedule(true);
}
// Shown again (possibly on another display, with another cap): resend.
window.addEventListener('focus', scheduleTrayResize);
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

// "Volver junto al icono": only while the user has pinned the popover away
// from the tray icon (dragged or resized it). Main pushes every change.
const resetTrayPositionBtn = byId('reset-tray-position', HTMLButtonElement);
function showPinned(pinned: boolean): void {
  resetTrayPositionBtn.hidden = !pinned;
}
resetTrayPositionBtn.addEventListener('click', () => {
  void window.api.resetTrayPosition();
});
window.api.onTrayPinned(showPinned);
window.api
  .getTrayPinned()
  .then(({ pinned }) => showPinned(pinned))
  .catch(() => {
    /* stays hidden: the popover is anchored as far as this window knows */
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

wireUpdateChip();

installTooltips();
watchCustomIcons();
