/**
 * The tree on the left: every scope you can open, and how each one is doing.
 *
 * It is redrawn from scratch only when its SHAPE changes (a group or a service
 * appeared or went away). Anything else — counters, dots, clocks, names — is
 * repainted in place, because a full rebuild would lose the scroll position,
 * the focus, and any click already in progress on a counter button.
 */
import { latestWins } from '../latest-wins.js';
import { PIPELINE_LOG_GROUP_ID } from '../../src/pipeline-labels.js';
import { logsParams } from './params.js';
import { renderHeaderRunState } from './header.js';
import { syncWatched } from './scope.js';
import { updateScrollButton } from './pane.js';
import {
  buildAllRow,
  buildGroupRow,
  buildPipelineRow,
  paintAllRow,
  paintGroupSummary,
  paintSideItem,
} from './sidebar-rows.js';
import { sideFilterEl, sideTreeEl, toggleSidebarBtn } from './elements.js';
import { view } from './view.js';

function renderSidebar(): void {
  sideTreeEl.textContent = '';
  if (!view.sideData.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No hay grupos configurados.';
    sideTreeEl.appendChild(empty);
    return;
  }
  sideTreeEl.appendChild(buildAllRow());
  // Right after "Todo", above every real group (Aggregator Log Placement):
  // a cross-cutting view, not one group among the others.
  const pipelineGroup = view.sideData.find(
    (group) => group.groupId === PIPELINE_LOG_GROUP_ID,
  );
  if (pipelineGroup) sideTreeEl.appendChild(buildPipelineRow(pipelineGroup));
  for (const group of view.sideData) {
    if (group.groupId === PIPELINE_LOG_GROUP_ID) continue; // rendered above
    sideTreeEl.appendChild(buildGroupRow(group));
  }
  applySideFilter();
}

/** Repaint in place when only the live numbers changed — keeps scroll & focus. */
function repaintSidebar(): boolean {
  // The root row's totals track live counts too, and no signature change ever
  // rebuilds it — so the fast path has to refresh it explicitly.
  const allRow = sideTreeEl.querySelector<HTMLElement>('.side-all');
  if (allRow) paintAllRow(allRow);
  for (const group of view.sideData) {
    // The pipeline bucket has no per-run rows to repaint (buildPipelineRow
    // renders none) — only its own rollup summary below.
    if (group.groupId !== PIPELINE_LOG_GROUP_ID) {
      for (const item of group.items) {
        const row = sideTreeEl.querySelector<HTMLElement>(
          `.side-item[data-id="${CSS.escape(item.id)}"]`,
        );
        if (!row) return false;
        paintSideItem(row, item);
      }
    }
    // The rollup tracks live counts too, or a collapsed group would go stale.
    const details = sideTreeEl.querySelector<HTMLElement>(
      `.side-group[data-group-id="${CSS.escape(group.groupId)}"]`,
    );
    if (details) paintGroupSummary(details, group);
  }
  return true;
}

function sideSignature(): string {
  return view.sideData
    .map((g) => `${g.groupId}:${g.items.map((i) => i.id).join(',')}`)
    .join('|');
}

function applySideFilter(): void {
  const needle = sideFilterEl.value.trim().toLowerCase();
  for (const details of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  )) {
    // A cross-cutting view like "Todo" (which this same filter never
    // touches), not a group of filterable items — it has none to search.
    if (details.dataset.groupId === PIPELINE_LOG_GROUP_ID) continue;
    let visible = 0;
    for (const row of Array.from(
      details.querySelectorAll<HTMLElement>('.side-item'),
    )) {
      const name = row.querySelector<HTMLElement>('.s-name')?.textContent ?? '';
      const ok = !needle || name.toLowerCase().includes(needle);
      row.classList.toggle('hidden', !ok);
      if (ok) visible += 1;
    }
    const count = details.querySelector<HTMLElement>('.g-count');
    if (count) count.textContent = String(visible);
    details.classList.toggle('hidden', visible === 0);
    if (needle && visible > 0 && details instanceof HTMLDetailsElement)
      details.open = true;
  }
}

/**
 * The shape the tree was last BUILT for. It starts as null rather than the
 * empty string because the empty string is a real signature — the one an
 * empty config produces — and starting equal to it left the first refresh on
 * the repaint path, so a window opened with nothing configured never got the
 * row that says so.
 */
let lastSignature: string | null = null;

/**
 * Ticket for the in-flight sidebar read, over its own state: `sideData`, not
 * the line buffer.
 *
 * The debounce in `onUpdate` only collapses refreshes still WAITING to start —
 * it never sees one already in flight. So the boot read and a pushed one can
 * overlap, and if the older answer arrives last it puts services back in the
 * sidebar that main has already dropped, until the next update redraws it.
 */
const sidebarLoads = latestWins();

export async function refreshSidebar(): Promise<void> {
  // Issuing this read retires every older one still in flight.
  sidebarLoads.invalidate();
  const current = sidebarLoads.claim();
  const listed = (await window.api.listLogs()) || [];
  if (!current()) return; // a newer refresh already answered
  view.sideData = listed;
  syncWatched();
  if (!logsParams.isDetached) {
    const signature = sideSignature();
    if (signature !== lastSignature || !repaintSidebar()) {
      lastSignature = signature;
      renderSidebar();
    }
  }
  renderHeaderRunState();
}

// ── Sidebar visibility (remembered across sessions) ───────────────
const SIDEBAR_KEY = 'devbar.logs.sidebar';

function applySidebarVisibility(collapsed: boolean): void {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  toggleSidebarBtn.title = collapsed
    ? 'Mostrar el panel lateral'
    : 'Ocultar el panel lateral';
  toggleSidebarBtn.setAttribute('aria-pressed', String(collapsed));
}

applySidebarVisibility(
  !logsParams.isDetached && localStorage.getItem(SIDEBAR_KEY) === 'collapsed',
);

toggleSidebarBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open');
  applySidebarVisibility(collapsed);
  updateScrollButton();
});

sideFilterEl.addEventListener('input', applySideFilter);

// One ticker for every live duration on screen (header + sidebar rows).
setInterval(() => {
  if (!logsParams.isDetached) repaintSidebar();
  renderHeaderRunState();
}, 1000);
