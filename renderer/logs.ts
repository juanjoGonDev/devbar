import { byId, closestElement, requireElement } from './dom.js';
import {
  canRun,
  dotClass,
  groupDotClass,
  isRunning,
  runtimeOf,
} from './log-status.js';
import {
  applySelection,
  selectModeFor,
  type Selection,
} from './line-selection.js';
import { renderPatternList, wireAddPattern } from './silence-ui.js';
import type { LogEntry } from '../src/domain-types.js';
import type {
  LogListGroup,
  LogListItem,
  LogSource,
  LogsTarget,
  SilenceLevel,
  SourcedLogEntry,
} from '../src/ipc-contract.js';
import { installTooltips } from './tooltip.js';

type AnsiStyle = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};
// ───────────────────────── ANSI parsing ──────────────────────────
const ANSI_ANY_RE = /\x1b\[[\d;?]*[a-zA-Z]/g;
const ANSI_SGR_RE = /\x1b\[([\d;?]*)([a-zA-Z])/g;

const PALETTE_FG: Record<number, string> = {
  30: '#3a3a3c',
  31: '#ff6961',
  32: '#5fdb86',
  33: '#ffd60a',
  34: '#5e9eff',
  35: '#d97cf2',
  36: '#7adfff',
  37: '#e5e5e7',
  90: '#8e8e93',
  91: '#ff8a8a',
  92: '#7eea9f',
  93: '#ffe066',
  94: '#85b6ff',
  95: '#e29bf6',
  96: '#a3e8ff',
  97: '#ffffff',
};

const PALETTE_BG: Record<number, string> = {
  40: '#3a3a3c',
  41: '#ff453a',
  42: '#30d158',
  43: '#a07a00',
  44: '#0a84ff',
  45: '#9543c1',
  46: '#0090a8',
  47: '#dcdce0',
  100: '#5e5e63',
  101: '#ff6961',
  102: '#5fdb86',
  103: '#ffe066',
  104: '#5e9eff',
  105: '#d97cf2',
  106: '#7adfff',
  107: '#f5f5f7',
};

function color256(n: number): string {
  if (n < 16) {
    const map = [
      30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97,
    ];
    const code = map[n];
    return code === undefined ? '#e5e5e7' : (PALETTE_FG[code] ?? '#e5e5e7');
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const ramp = [0, 95, 135, 175, 215, 255];
  return `rgb(${ramp[r] ?? 0},${ramp[g] ?? 0},${ramp[b] ?? 0})`;
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

function spanFor(text: string, style: AnsiStyle): string {
  if (!text) return '';
  const css: string[] = [];
  if (style.fg) css.push(`color:${style.fg}`);
  if (style.bg) css.push(`background:${style.bg}`);
  if (style.bold) css.push('font-weight:600');
  if (style.dim) css.push('opacity:0.65');
  if (style.italic) css.push('font-style:italic');
  if (style.underline) css.push('text-decoration:underline');
  if (!css.length) return escapeHtml(text);
  return `<span style="${css.join(';')}">${escapeHtml(text)}</span>`;
}

function clamp255(n: number | undefined): number {
  return Math.max(0, Math.min(255, (n ?? 0) | 0));
}

function applyCodes(codeStr: string, style: AnsiStyle): void {
  const codes = (codeStr || '')
    .split(';')
    .map((s) => (s === '' ? 0 : parseInt(s, 10)));
  let i = 0;
  while (i < codes.length) {
    const rawCode = codes[i];
    const c = rawCode === undefined || Number.isNaN(rawCode) ? 0 : rawCode;
    if (c === 0) {
      style.fg = null;
      style.bg = null;
      style.bold = false;
      style.dim = false;
      style.italic = false;
      style.underline = false;
    } else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 22) {
      style.bold = false;
      style.dim = false;
    } else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 39) style.fg = null;
    else if (c === 49) style.bg = null;
    else if (PALETTE_FG[c]) style.fg = PALETTE_FG[c];
    else if (PALETTE_BG[c]) style.bg = PALETTE_BG[c];
    else if (c === 38 && codes[i + 1] === 5) {
      style.fg = color256(codes[i + 2] || 0);
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      style.fg = `rgb(${clamp255(codes[i + 2])},${clamp255(codes[i + 3])},${clamp255(codes[i + 4])})`;
      i += 4;
    } else if (c === 48 && codes[i + 1] === 5) {
      style.bg = color256(codes[i + 2] || 0);
      i += 2;
    } else if (c === 48 && codes[i + 1] === 2) {
      style.bg = `rgb(${clamp255(codes[i + 2])},${clamp255(codes[i + 3])},${clamp255(codes[i + 4])})`;
      i += 4;
    }
    i += 1;
  }
}

function ansiToHtml(line: string): string {
  const cleaned = line.replace(/\r/g, '');
  const out: string[] = [];
  const style: AnsiStyle = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
  ANSI_SGR_RE.lastIndex = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_SGR_RE.exec(cleaned)) !== null) {
    const text = cleaned.slice(lastIndex, m.index);
    if (text) out.push(spanFor(text, style));
    if (m[2] === 'm') applyCodes(m[1] ?? '', style);
    lastIndex = ANSI_SGR_RE.lastIndex;
  }
  out.push(spanFor(cleaned.slice(lastIndex), style));
  return out.join('');
}

function stripAnsi(s: string): string {
  return (s || '').replace(ANSI_ANY_RE, '');
}

// ────────────────────────── DOM refs ─────────────────────────────
const params = new URLSearchParams(location.search);
// A detached window shows a single log and hides the sidebar; the shared
// window keeps the sidebar and swaps the visible log in place.
const isDetached = params.get('detached') === '1';
if (isDetached) document.body.classList.add('detached');
// Pre-set filter if passed as a query param (e.g. from counter-button click)
const initialFilter = params.get('filter') || '';
// Opened straight onto a merged scope (tray telemetry button / alert totals).
const rawScope = params.get('scope');
const rawGroupId = params.get('groupId');
const initialScope: Scope | null =
  rawScope === 'group' && rawGroupId
    ? { kind: 'group', groupId: rawGroupId }
    : rawScope === 'all'
      ? { kind: 'all' }
      : null;
const rawLevel = params.get('level');
const initialLevel: SilenceLevel | null =
  rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : null;

const titleEl = byId<HTMLElement>('title', HTMLElement);
const uptimeBadgeEl = byId<HTMLElement>('uptime-badge', HTMLElement);
const linesEl = byId<HTMLElement>('lines', HTMLElement);
const filterEl = byId<HTMLInputElement>('filter', HTMLInputElement);
const autoscrollEl = byId<HTMLInputElement>('autoscroll', HTMLInputElement);
const pausedEl = byId<HTMLInputElement>('paused', HTMLInputElement);
const clearBtn = byId<HTMLButtonElement>('clear', HTMLButtonElement);
const copyBtn = byId<HTMLButtonElement>('copy', HTMLButtonElement);
const countsEl = byId<HTMLElement>('counts', HTMLElement);
const statusEl = byId<HTMLElement>('status', HTMLElement);
const mainEl = requireElement<HTMLElement>('main', HTMLElement);
const muteWarnEl = byId<HTMLInputElement>('mute-warn', HTMLInputElement);
const muteErrEl = byId<HTMLInputElement>('mute-err', HTMLInputElement);
const togglePanelBtn = byId<HTMLButtonElement>(
  'toggle-silenced',
  HTMLButtonElement,
);
const levelPillEl = byId<HTMLButtonElement>('level-pill', HTMLButtonElement);
const levelPillTextEl = byId<HTMLElement>('level-pill-text', HTMLElement);
const scrollBtn = byId<HTMLButtonElement>('scroll-bottom', HTMLButtonElement);
const runBtn = byId<HTMLButtonElement>('run-toggle', HTMLButtonElement);
const detachBtn = byId<HTMLButtonElement>('detach', HTMLButtonElement);
const sideTreeEl = byId<HTMLElement>('side-tree', HTMLElement);
const sideFilterEl = byId<HTMLInputElement>('side-filter', HTMLInputElement);
const toggleSidebarBtn = byId<HTMLButtonElement>(
  'toggle-sidebar',
  HTMLButtonElement,
);

// ─────────────────────────── State ───────────────────────────────
let processId = params.get('id');
// Current resolved target (group + command/action)
let currentTarget: LogsTarget | null = null;
// groupId + commandId extracted from processId for silence ops
let currentGroupId: string | null = null;
let currentCommandId: string | null = null;
let globalMaxLogLines = 10_000;
let RENDER_LIMIT = 2000;
let visibleCount = 0;
const pendingQueue: LogEntry[] = [];
let filterRe: RegExp | null = null;
// Last sidebar snapshot — also the source of truth for the header's run
// button and uptime, so commands, actions and pre-scripts all work the same.
let sideData: LogListGroup[] = [];

function itemById(id: string): LogListItem | null {
  for (const group of sideData) {
    for (const item of group.items) if (item.id === id) return item;
  }
  return null;
}

function currentItem(): LogListItem | null {
  return processId ? itemById(processId) : null;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0') +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function buildFilter(value: string): RegExp | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new RegExp(trimmed, 'i');
  } catch (_) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
}

/**
 * Levels the view is pinned to. Empty means "show everything"; otherwise only
 * lines of the selected levels survive. Combines with the text filter — both
 * must pass.
 */
const levelFilter = new Set<SilenceLevel>();

/**
 * The three scopes the window can show. Every entry point — nav counters, tray
 * icons, a line's own tags — resolves to one of these, optionally pinned to a
 * level. Keeping it one type is what makes the level filter behave identically
 * everywhere instead of once per view.
 */
type Scope =
  | { kind: 'all' }
  | { kind: 'group'; groupId: string }
  | { kind: 'single'; processId: string };

/**
 * srcId → source while the window shows a merged stream; null in single mode.
 * Doubles as the "am I merged" flag.
 */
let groupSources: Map<string, LogSource> | null = null;
let currentGroupView: string | null = null;
/** Distinguishes the generic view from a single-group one; both are merged. */
let mergedIsAll = false;

/** Open any scope, optionally pinned to the levels the caller cares about. */
async function openScope(
  scope: Scope,
  levels: readonly SilenceLevel[] = [],
): Promise<void> {
  setLevelFilter(levels);
  if (scope.kind === 'single') await selectLog(scope.processId);
  else await selectMergedLog(scope.kind === 'group' ? scope.groupId : null);
}

/**
 * Jump from a merged row into that service's own view, landing on the same
 * line. The timestamp is the handle: it survives the switch, the row does not.
 */
async function jumpToLine(srcId: string, ts: number): Promise<void> {
  await openScope({ kind: 'single', processId: srcId }, [...levelFilter]);
  const row = Array.from(linesEl.children).find(
    (node) => node instanceof HTMLElement && node.dataset.ts === String(ts),
  );
  if (!(row instanceof HTMLElement)) return;
  autoscrollEl.checked = false;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

/** Stable per-name hue, so one service keeps its tag colour between runs. */
function sourceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 68%)`;
}

/** The level a line counts as, ignoring whether it was silenced. */
function levelOf(entry: LogEntry): string {
  return entry.originalLevel ?? entry.level ?? '';
}

function matchesLevel(level: string): boolean {
  if (!levelFilter.size) return true;
  return levelFilter.has(level as SilenceLevel);
}

function matchesFilter(entry: LogEntry): boolean {
  if (!matchesLevel(levelOf(entry))) return false;
  if (!filterRe) return true;
  return filterRe.test(stripAnsi(entry.line));
}

/** Show the escape hatch only while a level filter is actually narrowing things. */
function renderLevelChips(_item?: LogListItem | null): void {
  const active = [...levelFilter];
  levelPillEl.hidden = active.length === 0;
  if (!active.length) return;
  const label = active
    .map((level) => (level === 'warn' ? '⚠ warnings' : '⛔ errores'))
    .join(' + ');
  setText(levelPillTextEl, `sólo ${label}`);
  levelPillEl.title = 'Quitar el filtro de nivel';
  levelPillEl.className = `level-pill ${active.includes('error') ? 'err' : 'warn'}`;
}

/**
 * Drop every filter and land on this line, in sequence with everything around
 * it. Filtering only ever hides rows — it never removes them — so putting a
 * warning back among its neighbours costs nothing but a repaint and a scroll.
 * That context is usually where the cause is: the line before the failure.
 */
function showInContext(row: HTMLElement): void {
  filterEl.value = '';
  setLevelFilter([]);
  // Always respond, even when nothing was filtered. A control that looks
  // pressable and answers with silence teaches you to stop pressing it; with
  // no filter on, centring and flashing the line is still a real answer.
  autoscrollEl.checked = false; // otherwise the tail yanks us away again
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation if it is already running
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

/** Replace the level pin outright — entry points set what they want to see. */
function setLevelFilter(levels: readonly SilenceLevel[]): void {
  levelFilter.clear();
  for (const level of levels) levelFilter.add(level);
  renderLevelChips();
  applyFilter();
}

function appendLine(entry: LogEntry): void {
  const div = document.createElement('div');
  const classes = ['line', entry.stream];
  if (entry.level) classes.push(entry.level);
  if (entry.silenced) classes.push('silenced');
  div.className = classes.join(' ');
  div.dataset.line = entry.line;
  div.dataset.level = levelOf(entry);
  div.dataset.ts = String(entry.ts); // handle for jumping between views
  if (entry.originalLevel) div.dataset.originalLevel = entry.originalLevel;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(entry.ts);
  // Plain `title`: installTooltips() takes it over and draws the styled bubble.
  ts.title = 'Ver en contexto · quita los filtros y centra esta línea';
  ts.addEventListener('click', (event) => {
    event.stopPropagation(); // don't disturb the line-selection handler
    showInContext(div);
  });
  div.appendChild(ts);
  // Right-click anywhere on the row does the same — but NOT ctrl+click. macOS
  // routes ctrl+click to `contextmenu`, and this list already spends ctrl on
  // toggling a row's selection (see selectModeFor). Without this guard the two
  // fire together: the row gets selected, then the flash animation paints over
  // its highlight and fades it out, so the selection looks like it vanished.
  // A real secondary click (right button, two-finger tap) leaves ctrlKey false.
  div.addEventListener('contextmenu', (event) => {
    if (event.ctrlKey) return;
    event.preventDefault();
    showInContext(div);
  });

  // Merged views: every row says where it came from, the way telemetry tools
  // label a mixed stream. Both tags are doors — the group tag opens that
  // group's merged view, the service tag drops into its own view on this very
  // line. Colour is derived from the name so a service keeps its tag.
  const srcId = (entry as SourcedLogEntry).srcId;
  const source = groupSources && srcId ? groupSources.get(srcId) : undefined;
  if (source) {
    div.dataset.src = source.name;
    div.dataset.group = source.groupName;
    // The group tag is redundant inside a single group's view.
    if (mergedIsAll) {
      const grp = document.createElement('button');
      grp.type = 'button';
      grp.className = 'src grp';
      // Brackets are part of the text, not decoration, so a copied line keeps
      // them: `11:47:56.340 [Back] [Normal] …`
      grp.textContent = `[${source.groupName}]`;
      grp.title = `Ver todo ${source.groupName}`;
      grp.style.color = sourceColor(source.groupName);
      grp.addEventListener('click', (event) => {
        event.stopPropagation();
        void openScope({ kind: 'group', groupId: source.groupId }, [
          ...levelFilter,
        ]);
      });
      div.appendChild(grp);
    }
    const src = document.createElement('button');
    src.type = 'button';
    src.className = 'src';
    src.textContent = `[${source.name}]`;
    src.title = `Ir a esta línea en ${source.name}`;
    src.style.color = sourceColor(source.name);
    src.addEventListener('click', (event) => {
      event.stopPropagation();
      void jumpToLine(srcId, entry.ts);
    });
    div.appendChild(src);
  }

  const body = document.createElement('span');
  body.className = 'body';
  body.innerHTML = ansiToHtml(entry.line);
  div.appendChild(body);

  if (
    (entry.originalLevel === 'warn' || entry.originalLevel === 'error') &&
    currentGroupId &&
    currentCommandId
  ) {
    const groupId = currentGroupId;
    const commandId = currentCommandId;
    const btn = document.createElement('button');
    btn.className = 'silence-btn';
    btn.textContent = entry.silenced ? '🔔' : '🔕';
    btn.title = entry.silenced
      ? 'Quitar silencio (esta línea)'
      : 'Silenciar este patrón (matchea por substring)';
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const lvl = entry.originalLevel as SilenceLevel;
      const cleaned = stripAnsi(entry.line).trim();
      // Build a regex pattern when possible so it matches across timestamp changes
      const pattern = cleaned
        ? window.api.buildSilencePattern(cleaned)
        : cleaned;
      if (entry.silenced) {
        // Try removing the built pattern first; then fall back to literal cleaned.
        // removeSilencePattern is a no-op when the pattern is not found.
        if (pattern && pattern !== cleaned) {
          await window.api.removeSilencePattern(
            groupId,
            commandId,
            lvl,
            pattern,
          );
        }
        await window.api.removeSilencePattern(groupId, commandId, lvl, cleaned);
      } else {
        await window.api.addSilencePattern(
          groupId,
          commandId,
          lvl,
          pattern || cleaned,
        );
      }
    });
    div.appendChild(btn);
  }

  if (entry.silenced) pushMutedLine(entry);

  if (!matchesFilter(entry)) div.classList.add('hidden');
  linesEl.appendChild(div);
  visibleCount += 1;

  while (visibleCount > RENDER_LIMIT && linesEl.firstChild) {
    linesEl.removeChild(linesEl.firstChild);
    visibleCount -= 1;
  }

  if (autoscrollEl.checked) {
    mainEl.scrollTop = mainEl.scrollHeight;
  }
  countsEl.textContent = `${linesEl.childElementCount} líneas`;
  updateScrollButton();
}

function applyFilter(): void {
  filterRe = buildFilter(filterEl.value);
  for (const node of Array.from(linesEl.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const text = stripAnsi(node.dataset.line || '');
    const ok =
      matchesLevel(node.dataset.level || '') &&
      (!filterRe || filterRe.test(text));
    node.classList.toggle('hidden', !ok);
  }
  if (autoscrollEl.checked) {
    mainEl.scrollTop = mainEl.scrollHeight;
  }
}

function flushQueue(): void {
  if (pausedEl.checked) return;
  while (pendingQueue.length) {
    const entry = pendingQueue.shift();
    if (entry) appendLine(entry);
  }
}

filterEl.addEventListener('input', applyFilter);
levelPillEl.addEventListener('click', () => setLevelFilter([]));
pausedEl.addEventListener('change', () => {
  statusEl.textContent = pausedEl.checked ? 'Pausado' : '';
  if (!pausedEl.checked) flushQueue();
});

clearBtn.addEventListener('click', async () => {
  // Wipe the real retained buffer (main), not just the visible DOM — otherwise
  // cleared lines reappear on the next live line or when the window reopens.
  if (processId) await window.api.clearLogs(processId);
  linesEl.innerHTML = '';
  visibleCount = 0;
  countsEl.textContent = '0 líneas';
  // Also drop lines queued while paused — otherwise resuming re-adds the very
  // lines the user just cleared.
  pendingQueue.length = 0;
  if (pausedEl.checked) statusEl.textContent = 'Pausado';
});

// ─────────────────────── Line selection & copy ───────────────────
// Selection lives in the DOM (`.line.selected`) so trimming the buffer or
// re-filtering can never leave it pointing at rows that are gone.
let anchorRow: HTMLElement | null = null;

function visibleRows(): HTMLElement[] {
  return Array.from(linesEl.children).filter(
    (n): n is HTMLElement =>
      n instanceof HTMLElement && !n.classList.contains('hidden'),
  );
}

function selectedRows(): HTMLElement[] {
  return visibleRows().filter((r) => r.classList.contains('selected'));
}

function paintSelection(rows: HTMLElement[], next: Selection): void {
  rows.forEach((row, i) =>
    row.classList.toggle('selected', next.selected.has(i)),
  );
  anchorRow = next.anchor === null ? null : (rows[next.anchor] ?? null);
  reportSelection();
}

function reportSelection(): void {
  const count = selectedRows().length;
  copyBtn.title = count ? `Copiar ${count} línea(s) seleccionada(s)` : 'Copiar';
  if (count) statusEl.textContent = `${count} seleccionada(s)`;
  else if (pausedEl.checked) statusEl.textContent = 'Pausado';
  else statusEl.textContent = '';
}

function clearSelection(): void {
  for (const row of Array.from(linesEl.children)) {
    if (row instanceof HTMLElement) row.classList.remove('selected');
  }
  anchorRow = null;
  reportSelection();
}

function selectAllVisible(): void {
  const rows = visibleRows();
  for (const row of rows) row.classList.add('selected');
  anchorRow = rows[0] ?? null;
  reportSelection();
}

// Shift-click would otherwise extend the browser's text selection instead.
linesEl.addEventListener('mousedown', (ev) => {
  if (ev.shiftKey) ev.preventDefault();
});

linesEl.addEventListener('click', (ev) => {
  // A drag that selected text is a text selection, not a row click.
  if (!window.getSelection()?.isCollapsed) return;
  const row = closestElement(ev.target, '.line');
  if (!row) return;
  const rows = visibleRows();
  const index = rows.indexOf(row);
  if (index < 0) return;
  const anchorIndex = anchorRow ? rows.indexOf(anchorRow) : -1;
  const prev: Selection = {
    selected: new Set(
      rows.flatMap((r, i) => (r.classList.contains('selected') ? [i] : [])),
    ),
    anchor: anchorIndex < 0 ? null : anchorIndex,
  };
  paintSelection(rows, applySelection(prev, index, selectModeFor(ev)));
});

// Clicking the empty space under the last line drops the selection.
mainEl.addEventListener('click', (ev) => {
  if (!closestElement(ev.target, '.line')) clearSelection();
});

function rowsToText(rows: HTMLElement[]): string {
  return rows
    .map((node) => {
      const ts = node.querySelector<HTMLElement>('.ts')?.textContent ?? '';
      const body = node.querySelector<HTMLElement>('.body')?.textContent ?? '';
      return `${ts} ${body}`;
    })
    .join('\n');
}

async function copyRows(rows: HTMLElement[]): Promise<void> {
  try {
    await navigator.clipboard.writeText(rowsToText(rows));
    statusEl.textContent = `Copiado ✓ (${rows.length})`;
    setTimeout(reportSelection, 1500);
  } catch (err) {
    statusEl.textContent = 'Error al copiar';
  }
}

// With a selection the button copies just that; with none, everything visible.
copyBtn.addEventListener('click', () => {
  const selected = selectedRows();
  void copyRows(selected.length ? selected : visibleRows());
});

detachBtn.addEventListener('click', () => {
  if (processId) window.api.openLogs({ processId, detached: true });
});

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
  !isDetached && localStorage.getItem(SIDEBAR_KEY) === 'collapsed',
);

toggleSidebarBtn.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open');
  applySidebarVisibility(collapsed);
  updateScrollButton();
});

const SCROLL_THRESHOLD = 4;

function isAtBottom(): boolean {
  return (
    mainEl.scrollTop + mainEl.clientHeight >=
    mainEl.scrollHeight - SCROLL_THRESHOLD
  );
}

function updateScrollButton(): void {
  if (!scrollBtn) return;
  const atBottom = isAtBottom();
  scrollBtn.classList.toggle('visible', !atBottom);
  if (atBottom && !autoscrollEl.checked) {
    autoscrollEl.checked = true;
  }
}

mainEl.addEventListener('scroll', () => {
  const atBottom = isAtBottom();
  if (!atBottom && autoscrollEl.checked) {
    autoscrollEl.checked = false;
  }
  updateScrollButton();
});

window.addEventListener('resize', updateScrollButton);

scrollBtn.addEventListener('click', () => {
  mainEl.scrollTop = mainEl.scrollHeight;
  autoscrollEl.checked = true;
  updateScrollButton();
});

document.addEventListener('keydown', (e) => {
  const accel = e.metaKey || e.ctrlKey;
  if (accel && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    filterEl.focus();
    filterEl.select();
    return;
  }
  // Leave the shortcuts alone while typing in the filter or the search box.
  if (document.activeElement instanceof HTMLInputElement) return;
  if (accel && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    selectAllVisible();
    return;
  }
  if (accel && (e.key === 'c' || e.key === 'C')) {
    // A real text selection wins — let the browser copy exactly that.
    if (!window.getSelection()?.isCollapsed) return;
    const selected = selectedRows();
    if (!selected.length) return;
    e.preventDefault();
    void copyRows(selected);
    return;
  }
  if (e.key === 'Escape') clearSelection();
});

// ───────────────────── Start / stop the shown log ────────────────
async function toggleRun(item: LogListItem): Promise<void> {
  if (isRunning(item)) {
    await window.api.stopProcess(item.id);
    return;
  }
  // Actions go through actions:run so their confirmation gate still applies.
  if (item.type === 'action') {
    const parts = item.id.split(':');
    const groupId = parts[1];
    const actionId = parts.slice(2).join(':');
    if (groupId && actionId) await window.api.runAction(groupId, actionId);
    return;
  }
  await window.api.startProcess(item.id);
}

runBtn.addEventListener('click', () => {
  const item = currentItem();
  if (item && canRun(item)) void toggleRun(item);
});

function renderHeaderRunState(): void {
  if (!processId || !_logsDisplayName) return;
  const item = currentItem();
  const runnable = canRun(item);
  runBtn.style.display = runnable ? '' : 'none';
  if (runnable) {
    const running = isRunning(item);
    runBtn.textContent = running ? '■' : '▶';
    runBtn.title = running ? 'Parar' : 'Arrancar';
    runBtn.classList.toggle('on', running);
  }
  const runtime = runtimeOf(item);
  const base = _logsGroupName
    ? `Logs — ${_logsGroupName} · ${_logsDisplayName}`
    : `Logs — ${_logsDisplayName}`;
  const uptime = runtime
    ? runtime.live
      ? runtime.text
      : `último: ${runtime.text}`
    : '';
  // This runs once a second for the ticking uptime. Writing the same string
  // back would still dirty the text node, so only touch what actually changed.
  setText(titleEl, base);
  setText(uptimeBadgeEl, uptime);
  uptimeBadgeEl.classList.toggle('visible', Boolean(runtime));
  const fullTitle = runtime ? `${base} · ${runtime.text}` : base;
  if (document.title !== fullTitle) document.title = fullTitle;
  renderLevelChips(item);
}

/** Write only when the content differs — keeps per-second updates flicker-free. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

let _logsDisplayName = '';
let _logsGroupName = '';

// ─────────────────────────── Sidebar ─────────────────────────────
const TYPE_ICON: Record<LogListItem['type'], string> = {
  command: '⚙️',
  action: '⚡️',
  prescript: '🧪',
  pipeline: '🧩',
};

function groupOpenKey(groupId: string): string {
  return `devbar.logs.group.${groupId}`;
}

/**
 * A count that is also the way in: pressing it opens that scope already
 * filtered to the level you pressed. Same control everywhere — service row,
 * group header, tray — only the destination changes.
 */
function levelCountButton(
  level: SilenceLevel,
  count: number,
  label: string,
  open: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `b ${level === 'warn' ? 'warn' : 'err'} clickable`;
  btn.title = label;
  btn.textContent = `${level === 'warn' ? '⚠' : '⛔'} ${count}`;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  });
  return btn;
}

function renderBadges(host: HTMLElement, item: LogListItem): void {
  host.textContent = '';
  if (item.warnCount > 0) {
    host.appendChild(
      levelCountButton(
        'warn',
        item.warnCount,
        `Ver los ${item.warnCount} warning(s) de ${item.name}`,
        () => void openScope({ kind: 'single', processId: item.id }, ['warn']),
      ),
    );
  }
  if (item.errorCount > 0) {
    host.appendChild(
      levelCountButton(
        'error',
        item.errorCount,
        `Ver los ${item.errorCount} error(es) de ${item.name}`,
        () => void openScope({ kind: 'single', processId: item.id }, ['error']),
      ),
    );
  }
  const runtime = runtimeOf(item);
  if (runtime) {
    const b = document.createElement('span');
    b.className = runtime.live ? 'b time live' : 'b time';
    b.title = runtime.live
      ? 'Tiempo en ejecución'
      : 'Duración de la última ejecución';
    b.textContent = `⏱ ${runtime.text}`;
    host.appendChild(b);
  }
  if (!host.childElementCount) {
    const b = document.createElement('span');
    b.className = 'b';
    b.textContent = `${item.lineCount} líneas`;
    host.appendChild(b);
  }
}

function buildSideItem(item: LogListItem): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'side-item';
  row.dataset.id = item.id;

  const dot = document.createElement('span');
  dot.className = 'dot';
  row.appendChild(dot);

  const ico = document.createElement('span');
  ico.className = 's-ico';
  ico.textContent = item.icon || TYPE_ICON[item.type];
  row.appendChild(ico);

  const mainCol = document.createElement('span');
  mainCol.className = 's-main';
  const name = document.createElement('span');
  name.className = 's-name';
  const badges = document.createElement('span');
  badges.className = 's-badges';
  mainCol.append(name, badges);
  row.appendChild(mainCol);

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 's-run';
  run.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Rows are repainted in place, so resolve the current state on click
    // instead of the snapshot this row was built from.
    const fresh = itemById(item.id);
    if (fresh) void toggleRun(fresh);
  });
  row.appendChild(run);

  row.addEventListener('click', () => void selectLog(item.id));
  return row;
}

function paintSideItem(row: HTMLElement, item: LogListItem): void {
  const dot = row.querySelector<HTMLElement>('.dot');
  if (dot) dot.className = `dot ${dotClass(item)}`.trim();
  const name = row.querySelector<HTMLElement>('.s-name');
  if (name) {
    name.textContent = item.name;
    name.title = item.name;
  }
  const badges = row.querySelector<HTMLElement>('.s-badges');
  if (badges) renderBadges(badges, item);
  const run = row.querySelector<HTMLButtonElement>('.s-run');
  if (run) {
    const runnable = canRun(item);
    run.style.display = runnable ? '' : 'none';
    const running = isRunning(item);
    run.textContent = running ? '■' : '▶';
    run.title = running ? 'Parar' : 'Arrancar';
    run.classList.toggle('on', running);
  }
  row.classList.toggle('active', item.id === processId);
}

/**
 * The root of the scope hierarchy, pinned above the groups: everything, from
 * everywhere. Without it the sidebar could walk you down (group → service) but
 * never back up to the whole picture.
 */
function buildAllRow(): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'side-all';
  row.classList.toggle('active', mergedIsAll);
  const ico = document.createElement('span');
  ico.className = 'a-ico';
  ico.textContent = '📜';
  const name = document.createElement('span');
  name.className = 'a-name';
  name.textContent = 'Todo';
  const badges = document.createElement('span');
  badges.className = 'a-badges';
  row.append(ico, name, badges);
  paintAllRow(row);
  row.title = 'Todos los logs de todos los grupos';
  row.addEventListener('click', () => void openScope({ kind: 'all' }));
  return row;
}

function renderSidebar(): void {
  sideTreeEl.textContent = '';
  if (!sideData.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No hay grupos configurados.';
    sideTreeEl.appendChild(empty);
    return;
  }
  sideTreeEl.appendChild(buildAllRow());
  for (const group of sideData) {
    const details = document.createElement('details');
    details.className = 'side-group';
    details.dataset.groupId = group.groupId;
    details.open =
      localStorage.getItem(groupOpenKey(group.groupId)) !== 'closed';
    details.addEventListener('toggle', () =>
      localStorage.setItem(
        groupOpenKey(group.groupId),
        details.open ? 'open' : 'closed',
      ),
    );
    const summary = document.createElement('summary');
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '▶';
    const gIco = document.createElement('span');
    gIco.className = 'g-ico';
    gIco.textContent = group.groupIcon || '📁';
    // Name on top, its group-wide warn/error totals underneath — the same
    // two-line shape the service rows use, so the eye reads them as a column.
    const gMain = document.createElement('span');
    gMain.className = 'g-main';
    const gName = document.createElement('span');
    gName.className = 'g-name';
    gName.textContent = group.groupName;
    const gBadges = document.createElement('span');
    gBadges.className = 'g-badges';
    gMain.append(gName, gBadges);
    // Rollup: how many services live here, and the worst state among them.
    const gDot = document.createElement('span');
    gDot.className = 'g-dot';
    const gCount = document.createElement('span');
    gCount.className = 'g-count';
    // Opens the merged view for the whole group. It lives inside <summary>, so
    // it must swallow the click — otherwise <details> would just fold shut.
    const gAll = document.createElement('button');
    gAll.type = 'button';
    gAll.className = 'g-all';
    gAll.textContent = '📜'; // same mark as every other "open logs" control
    gAll.title = `Ver todos los logs de ${group.groupName} juntos`;
    gAll.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openScope({ kind: 'group', groupId: group.groupId });
    });
    summary.append(chevron, gIco, gMain, gDot, gCount, gAll);
    details.appendChild(summary);
    // Items live in their own box so the guide rail can hang off it.
    const box = document.createElement('div');
    box.className = 'side-items';
    for (const item of group.items) {
      const row = buildSideItem(item);
      paintSideItem(row, item);
      box.appendChild(row);
    }
    details.appendChild(box);
    paintGroupSummary(details, group);
    sideTreeEl.appendChild(details);
  }
  applySideFilter();
}

/**
 * Refresh a group header: the rollup dot, and the warn/error totals of
 * everything inside it. Those totals are buttons — they open the group's
 * merged view already pinned to that level.
 */
function paintAllRow(row: HTMLElement): void {
  const badges = row.querySelector<HTMLElement>('.a-badges');
  if (!badges) return;
  const items = sideData.flatMap((group) => group.items);
  const warns = items.reduce((sum, item) => sum + item.warnCount, 0);
  const errors = items.reduce((sum, item) => sum + item.errorCount, 0);
  const signature = `${warns}/${errors}`;
  if (badges.dataset.signature === signature) return;
  badges.dataset.signature = signature;
  badges.textContent = '';
  if (warns > 0)
    badges.appendChild(
      levelCountButton(
        'warn',
        warns,
        `Ver los ${warns} warning(s) de todo`,
        () => void openScope({ kind: 'all' }, ['warn']),
      ),
    );
  if (errors > 0)
    badges.appendChild(
      levelCountButton(
        'error',
        errors,
        `Ver los ${errors} error(es) de todo`,
        () => void openScope({ kind: 'all' }, ['error']),
      ),
    );
}

function paintGroupSummary(details: HTMLElement, group: LogListGroup): void {
  const dot = details.querySelector<HTMLElement>('.g-dot');
  if (dot) {
    const state = groupDotClass(group.items);
    dot.className = `g-dot ${state}`.trim();
    dot.title = state ? `Estado del grupo: ${state}` : '';
  }
  const host = details.querySelector<HTMLElement>('.g-badges');
  if (!host) return;
  const warns = group.items.reduce((sum, item) => sum + item.warnCount, 0);
  const errors = group.items.reduce((sum, item) => sum + item.errorCount, 0);
  // Cheap guard against rebuilding these buttons on every one-second tick.
  const signature = `${warns}/${errors}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.textContent = '';
  if (warns > 0)
    host.appendChild(
      levelCountButton(
        'warn',
        warns,
        `Ver los ${warns} warning(s) de ${group.groupName}`,
        () =>
          void openScope({ kind: 'group', groupId: group.groupId }, ['warn']),
      ),
    );
  if (errors > 0)
    host.appendChild(
      levelCountButton(
        'error',
        errors,
        `Ver los ${errors} error(es) de ${group.groupName}`,
        () =>
          void openScope({ kind: 'group', groupId: group.groupId }, ['error']),
      ),
    );
}

/** Repaint in place when only the live numbers changed — keeps scroll & focus. */
function repaintSidebar(): boolean {
  // The root row's totals track live counts too, and no signature change ever
  // rebuilds it — so the fast path has to refresh it explicitly.
  const allRow = sideTreeEl.querySelector<HTMLElement>('.side-all');
  if (allRow) paintAllRow(allRow);
  for (const group of sideData) {
    for (const item of group.items) {
      const row = sideTreeEl.querySelector<HTMLElement>(
        `.side-item[data-id="${CSS.escape(item.id)}"]`,
      );
      if (!row) return false;
      paintSideItem(row, item);
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
  return sideData
    .map((g) => `${g.groupId}:${g.items.map((i) => i.id).join(',')}`)
    .join('|');
}

function applySideFilter(): void {
  const needle = sideFilterEl.value.trim().toLowerCase();
  for (const details of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  )) {
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

sideFilterEl.addEventListener('input', applySideFilter);

let lastSignature = '';

async function refreshSidebar(): Promise<void> {
  sideData = (await window.api.listLogs()) || [];
  if (!isDetached) {
    const signature = sideSignature();
    if (signature !== lastSignature || !repaintSidebar()) {
      lastSignature = signature;
      renderSidebar();
    }
  }
  renderHeaderRunState();
}

// One ticker for every live duration on screen (header + sidebar rows).
setInterval(() => {
  if (!isDetached) repaintSidebar();
  renderHeaderRunState();
}, 1000);

// ─────────────────────── Silence / target state ──────────────────
function applyTargetSnapshot(target: LogsTarget): void {
  if (!target) return;
  currentTarget = target;
  // Only commands have silence settings
  if (target.kind === 'command' && target.target) {
    const cmd = target.target;
    muteWarnEl.checked = !!cmd.silenceWarnings;
    muteErrEl.checked = !!cmd.silenceErrors;
  }
}

function clientMatchesPattern(p: string, lineText: string): boolean {
  if (!p) return false;
  // Mirror process-manager heuristic: backslash present → try as regex.
  if (!p.includes('\\')) return lineText.includes(p);
  try {
    return new RegExp(p, 'i').test(lineText);
  } catch (_) {
    return lineText.includes(p);
  }
}

function rerenderExistingLines(): void {
  if (
    !currentTarget ||
    currentTarget.kind !== 'command' ||
    !currentTarget.target
  )
    return;
  const sp = currentTarget.target.silencedPatterns || { warn: [], error: [] };
  for (const node of Array.from(linesEl.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const orig = node.dataset.originalLevel as SilenceLevel | undefined;
    if (!orig) continue;
    const list = sp[orig] || [];
    const lineText = stripAnsi(node.dataset.line || '');
    const isSilenced = list.some((p) => clientMatchesPattern(p, lineText));
    node.classList.toggle('silenced', isSilenced);
    node.classList.toggle('warn', orig === 'warn' && !isSilenced);
    node.classList.toggle('error', orig === 'error' && !isSilenced);
    const btn = node.querySelector<HTMLButtonElement>('.silence-btn');
    if (btn) {
      btn.textContent = isSilenced ? '🔔' : '🔕';
      btn.title = isSilenced
        ? 'Quitar silencio (esta línea)'
        : 'Silenciar este patrón (matchea por substring)';
    }
  }
}

muteWarnEl.addEventListener('change', () => {
  if (currentGroupId && currentCommandId) {
    window.api.setCommandSilence(
      currentGroupId,
      currentCommandId,
      'warn',
      muteWarnEl.checked,
    );
  }
});
muteErrEl.addEventListener('change', () => {
  if (currentGroupId && currentCommandId) {
    window.api.setCommandSilence(
      currentGroupId,
      currentCommandId,
      'error',
      muteErrEl.checked,
    );
  }
});

// ─────────────────────── Silenced drawer ─────────────────────────

const drawerEl = byId<HTMLElement>('silenced-drawer', HTMLElement);
const drawerTargetEl = byId<HTMLElement>('drawer-target', HTMLElement);
const drawerCloseBtn = byId<HTMLButtonElement>(
  'drawer-close',
  HTMLButtonElement,
);
const warnListEl = byId<HTMLUListElement>('warn-list', HTMLUListElement);
const errListEl = byId<HTMLUListElement>('err-list', HTMLUListElement);
const warnInputEl = byId<HTMLInputElement>('warn-input', HTMLInputElement);
const errInputEl = byId<HTMLInputElement>('err-input', HTMLInputElement);
const warnAddBtn = byId<HTMLButtonElement>('warn-add', HTMLButtonElement);
const errAddBtn = byId<HTMLButtonElement>('err-add', HTMLButtonElement);
const warnFeedEl = byId<HTMLElement>('warn-feed', HTMLElement);
const errFeedEl = byId<HTMLElement>('err-feed', HTMLElement);

/** Distinct swallowed lines kept per level before the oldest is dropped. */
const MUTED_FEED_LIMIT = 60;

/**
 * Collapse a line to the shape it shares with its repeats: numbers, hex ids and
 * UUIDs vary run to run, the skeleton does not. Two lines with the same
 * skeleton are the same event happening twice.
 */
function mutedKey(line: string): string {
  return stripAnsi(line)
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '§')
    .replace(/0x[0-9a-f]+/gi, '§')
    .replace(/\d+/g, '§')
    .slice(0, 200);
}

function drawerOpen(): boolean {
  return !drawerEl.hidden;
}

/** Repaint the drawer's pattern lists and target label from current state. */
function renderDrawer(): void {
  if (!drawerOpen()) return;
  const target = currentTarget;
  const patterns =
    target && target.kind === 'command' && target.target
      ? target.target.silencedPatterns || { warn: [], error: [] }
      : { warn: [], error: [] };
  setText(
    drawerTargetEl,
    _logsDisplayName
      ? _logsGroupName
        ? `${_logsGroupName} · ${_logsDisplayName}`
        : _logsDisplayName
      : '',
  );
  const groupId = currentGroupId;
  const commandId = currentCommandId;
  const remove = (level: SilenceLevel) => (pattern: string) => {
    if (!groupId || !commandId) return;
    void window.api.removeSilencePattern(groupId, commandId, level, pattern);
  };
  renderPatternList(warnListEl, patterns.warn || [], 'warn', {
    onRemove: remove('warn'),
  });
  renderPatternList(errListEl, patterns.error || [], 'error', {
    onRemove: remove('error'),
  });
}

/**
 * Mirror a swallowed line into the drawer feed. Seeing WHAT a pattern eats is
 * the point — a rule you cannot inspect is a rule you stop trusting.
 */
/** Wipe both feeds — called on every scope switch, see pushMutedLine. */
function clearMutedFeeds(): void {
  warnFeedEl.textContent = '';
  errFeedEl.textContent = '';
  renderMutedCounts();
}

function pushMutedLine(entry: LogEntry): void {
  const level = entry.originalLevel;
  if (level !== 'warn' && level !== 'error') return;
  // Silencing is per-service, and unsilenceLine acts on the CURRENT selection.
  // A merged scope mixes many services, so a row here would remove a pattern
  // from whichever command happened to be selected — the wrong one.
  if (groupSources) return;
  const feed = level === 'warn' ? warnFeedEl : errFeedEl;
  const key = mutedKey(entry.line);

  const existing = feed.querySelector<HTMLElement>(
    `.muted-line[data-key="${CSS.escape(key)}"]`,
  );
  if (existing) {
    const next = Number(existing.dataset.count ?? '1') + 1;
    existing.dataset.count = String(next);
    const badge = existing.querySelector<HTMLElement>('.rep');
    if (badge) {
      badge.textContent = `×${next}`;
      badge.hidden = false;
    }
    const ts = existing.querySelector<HTMLElement>('.ts');
    if (ts) ts.textContent = fmtTime(entry.ts); // most recent sighting
    feed.appendChild(existing); // float the noisy one back to the bottom
  } else {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `muted-line ${level}`;
    row.dataset.key = key;
    row.dataset.count = '1';
    row.title = 'Dejar de silenciar este patrón';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime(entry.ts);
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = stripAnsi(entry.line);
    const rep = document.createElement('span');
    rep.className = 'rep';
    rep.hidden = true;
    row.append(ts, body, rep);
    row.addEventListener('click', () => void unsilenceLine(entry));
    feed.appendChild(row);
    while (feed.childElementCount > MUTED_FEED_LIMIT && feed.firstChild)
      feed.removeChild(feed.firstChild);
  }
  renderMutedCounts();
}

/** Header counts are total sightings, not distinct rows. */
function renderMutedCounts(): void {
  for (const [feed, level] of [
    [warnFeedEl, 'warn'],
    [errFeedEl, 'error'],
  ] as const) {
    const total = Array.from(feed.children).reduce(
      (sum, node) =>
        sum +
        (node instanceof HTMLElement ? Number(node.dataset.count ?? '1') : 0),
      0,
    );
    const badge = drawerEl.querySelector<HTMLElement>(
      `.drawer-count[data-count="${level}"]`,
    );
    if (badge) setText(badge, String(total));
  }
}

/** One click from the feed drops whichever rule is swallowing that line. */
async function unsilenceLine(entry: LogEntry): Promise<void> {
  const level = entry.originalLevel;
  if (!level || !currentGroupId || !currentCommandId) return;
  const cleaned = stripAnsi(entry.line).trim();
  const built = cleaned ? window.api.buildSilencePattern(cleaned) : cleaned;
  if (built && built !== cleaned)
    await window.api.removeSilencePattern(
      currentGroupId,
      currentCommandId,
      level,
      built,
    );
  await window.api.removeSilencePattern(
    currentGroupId,
    currentCommandId,
    level,
    cleaned,
  );
}

function setDrawer(open: boolean): void {
  drawerEl.hidden = !open;
  togglePanelBtn.classList.toggle('on', open);
  if (open) renderDrawer();
}

for (const [input, button, level] of [
  [warnInputEl, warnAddBtn, 'warn'],
  [errInputEl, errAddBtn, 'error'],
] as const) {
  wireAddPattern(input, button, level, {
    onAdd: (pattern) => {
      if (!currentGroupId || !currentCommandId) return;
      void window.api.addSilencePattern(
        currentGroupId,
        currentCommandId,
        level,
        pattern,
      );
    },
  });
}

drawerCloseBtn.addEventListener('click', () => setDrawer(false));
togglePanelBtn.addEventListener('click', () => setDrawer(!drawerOpen()));

// ─────────────────────── Switching between logs ──────────────────
/**
 * Merge several services into one stream: a whole group, or every group when
 * `groupId` is null (the generic telemetry view). Each row is tagged with its
 * source, so a mixed feed stays readable without splitting the window.
 * Selecting an individual service afterwards drops back to single mode.
 */
async function selectMergedLog(groupId: string | null): Promise<void> {
  processId = null;
  clearMutedFeeds(); // rows from the previous scope would target the wrong command
  mergedIsAll = groupId === null;
  currentGroupView = groupId ?? '*';
  linesEl.textContent = '';
  visibleCount = 0;
  pendingQueue.length = 0;
  currentTarget = null;
  currentGroupId = null;
  currentCommandId = null;
  anchorRow = null;
  setDrawer(false); // silencing is per-service; it has no meaning here
  RENDER_LIMIT = globalMaxLogLines;

  const token = currentGroupView;
  const res = await window.api.getMergedLogs(groupId);
  if (currentGroupView !== token) return; // a newer switch won the race
  groupSources = new Map(res.sources.map((s) => [s.id, s]));
  _logsDisplayName = groupId ? 'todos' : '';
  _logsGroupName = res.groupName;
  const heading = groupId ? `Logs — ${res.groupName} · todos` : 'Telemetría';
  setText(titleEl, heading);
  document.title = heading;
  uptimeBadgeEl.classList.remove('visible');
  runBtn.style.display = 'none';
  renderLevelChips();

  for (const entry of res.lines) appendLine(entry);
  countsEl.textContent = `${linesEl.childElementCount} líneas`;
  for (const row of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-item'),
  ))
    row.classList.remove('active');
  for (const summary of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  ))
    summary.classList.toggle('viewing', summary.dataset.groupId === groupId);
  sideTreeEl
    .querySelector<HTMLElement>('.side-all')
    ?.classList.toggle('active', mergedIsAll);
}

async function selectLog(id: string, filter?: string): Promise<void> {
  processId = id;
  groupSources = null;
  clearMutedFeeds(); // rows from the previous scope would target the wrong command
  currentGroupView = null;
  mergedIsAll = false;
  for (const summary of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  ))
    summary.classList.remove('viewing');
  sideTreeEl
    .querySelector<HTMLElement>('.side-all')
    ?.classList.remove('active');
  linesEl.textContent = '';
  visibleCount = 0;
  pendingQueue.length = 0;
  countsEl.textContent = '0 líneas';
  statusEl.textContent = pausedEl.checked ? 'Pausado' : '';
  currentTarget = null;
  currentGroupId = null;
  currentCommandId = null;
  anchorRow = null;
  muteWarnEl.checked = false;
  muteErrEl.checked = false;
  if (filter !== undefined) filterEl.value = filter;
  filterRe = buildFilter(filterEl.value);

  // getLogs also points main's live stream at this buffer, atomically.
  const res = await window.api.getLogs(id);
  if (processId !== id) return; // a newer switch won the race
  // Render limit: per-command override → global setting → fallback 2000
  const cmdLimit =
    res.target.kind === 'command' ? res.target.target.maxLogLines : null;
  RENDER_LIMIT = cmdLimit != null ? cmdLimit : globalMaxLogLines;

  const target = res.target;
  if (target && target.group && target.target) {
    applyTargetSnapshot(target);
    _logsDisplayName = target.target.name || id;
    _logsGroupName = target.group.name;
    if (target.kind === 'command') {
      currentGroupId = target.group.id;
      currentCommandId = target.target.id;
    }
  } else {
    _logsDisplayName = id;
    _logsGroupName = '';
  }

  for (const entry of res.lines) appendLine(entry);
  if (!isDetached) {
    for (const row of Array.from(
      sideTreeEl.querySelectorAll<HTMLElement>('.side-item'),
    )) {
      row.classList.toggle('active', row.dataset.id === id);
    }
  }
  renderHeaderRunState();
}

// ─────────────────────────── Bootstrap ───────────────────────────
(async () => {
  const settings = await window.api.getSettings();
  globalMaxLogLines = (settings && settings.maxLogLines) || 10_000;
  if (initialFilter) filterEl.value = initialFilter;
  await refreshSidebar();
  if (initialScope) {
    await openScope(initialScope, initialLevel ? [initialLevel] : []);
  } else if (processId) {
    await selectLog(processId, initialFilter || undefined);
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
  if (isDetached) {
    if (pid !== processId || payload.filter === undefined) return;
    filterEl.value = payload.filter;
    applyFilter();
    return;
  }
  void selectLog(pid, payload.filter);
});

window.api.onLog((payload) => {
  if (!payload) return;
  // In group mode any member's line belongs here; tag it with its source so
  // appendLine can label the row.
  if (groupSources) {
    if (!groupSources.has(payload.id)) return;
    const sourced = { ...payload.entry, srcId: payload.id };
    if (pausedEl.checked) {
      pendingQueue.push(sourced);
      statusEl.textContent = `Pausado (+${pendingQueue.length})`;
      return;
    }
    appendLine(sourced);
    return;
  }
  if (payload.id !== processId) return;
  if (pausedEl.checked) {
    pendingQueue.push(payload.entry);
    statusEl.textContent = `Pausado (+${pendingQueue.length})`;
    return;
  }
  appendLine(payload.entry);
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
