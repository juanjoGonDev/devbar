/**
 * The logs window.
 *
 * What is left here is only the wiring: pull the panes in, tell them what the
 * window was opened for, and route what main pushes. Everything the window
 * actually DOES lives under `renderer/logs/` — the line pane, the sidebar, the
 * silenced drawer, the scope switcher — each small enough to read in one sitting
 * and testable without the others.
 */
import { initTheme } from './theme.js';
import { installTooltips } from './tooltip.js';
import { logsParams } from './logs/params.js';
import { installNav, view } from './logs/view.js';
import { filterEl, titleEl } from './logs/elements.js';
import { applyFilter, rerenderExistingLines } from './logs/pane.js';
import { renderDrawer } from './logs/drawer.js';
import { jumpToLine, openScope, selectLog } from './logs/scope.js';
import { refreshSidebar } from './logs/sidebar.js';
import { receivePush } from './logs/stream.js';
import './logs/selection-ui.js';
import { DEFAULT_MAX_LOG_LINES } from '../src/domain-types.js';

initTheme();

// A detached window shows a single log and hides the sidebar; the shared
// window keeps the sidebar and swaps the visible log in place.
if (logsParams.isDetached) document.body.classList.add('detached');
view.processId = logsParams.processId;

// A row that opens another scope cannot import the switcher back without
// closing a cycle, so the switcher is handed to it here instead.
installNav({ openScope, jumpToLine });

// ─────────────────────────── Bootstrap ───────────────────────────
(async () => {
  // Retention bounds what the renderer HOLDS; the window decides what it draws.
  const settings = await window.api.getSettings();
  view.globalRetention = settings?.maxLogLines || DEFAULT_MAX_LOG_LINES;
  view.memoryCap = view.globalRetention;
  if (logsParams.filter) filterEl.value = logsParams.filter;
  await refreshSidebar();
  if (logsParams.scope) {
    await openScope(
      logsParams.scope,
      logsParams.level ? [logsParams.level] : [],
    );
  } else if (view.processId) {
    await selectLog(
      view.processId,
      logsParams.filter || undefined,
      logsParams.level ?? undefined,
    );
  } else {
    titleEl.textContent = 'Logs (sin proceso)';
  }
})();

// Main asks the shared window to switch (or a detached one to re-filter).
window.api.onLogsSelect((payload) => {
  if (payload.scope) {
    void openScope(
      payload.scope === 'group' && payload.groupId
        ? { kind: 'group', groupId: payload.groupId }
        : { kind: 'all' },
      payload.level ? [payload.level] : [],
    );
    return;
  }
  const pid = payload.processId;
  if (!pid) return;
  if (logsParams.isDetached) {
    if (pid !== view.processId || payload.filter === undefined) return;
    filterEl.value = payload.filter;
    applyFilter();
    return;
  }
  void selectLog(pid, payload.filter, payload.level ?? undefined);
});

window.api.onLog((payload) => {
  if (!payload) return;
  receivePush(payload);
});

// Any state change (start, stop, new warn/error) → refresh the live numbers.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
window.api.onUpdate(() => {
  rerenderExistingLines();
  renderDrawer(); // patterns may have just been added or removed
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSidebar();
  }, 250);
});

installTooltips();
