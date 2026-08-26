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
import {
  clampWindow,
  extendBottom,
  extendTop,
  initialWindow,
  windowAround,
} from './log-window.js';
import { DEFAULT_MAX_LOG_LINES } from '../src/domain-types.js';
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
/** Distinguishes the generic view from a single-group one; both are merged. */
let mergedIsAll = false;
/** The merged scope on screen, so unknown sources can be looked up again. */
let mergedGroupId: string | null = null;
let refreshingSources = false;
/**
 * Lines whose source was unknown, waiting on the lookup that will name it.
 * Each is stamped with the scope it arrived in: a lookup that resolves after
 * the view moved on must not deliver another scope's lines.
 */
const unknownSourceQueue: { entry: SourcedLogEntry; scope: number }[] = [];
/**
 * Ticket for the in-flight log load. Identity is not enough to detect a lost
 * race: two overlapping loads of the SAME scope share it, so both would pass
 * the guard and each would append its own snapshot — duplicating the history.
 * A counter makes every call distinguishable, including from itself.
 */
let loadSeq = 0;

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
  // Search the BUFFER, not the DOM: after the switch the line is almost
  // certainly outside the drawn window, so the window is moved to it.
  const entryIndex = entries.findIndex((entry) => entry.ts === ts);
  if (entryIndex < 0) return;
  autoscrollEl.checked = false;
  flashEntry(entryIndex);
}

/**
 * Refresh the merged source list after a line from a service we did not know
 * about. Guarded: a burst of lines from a new pre-script must not fire one
 * lookup each. The line that triggered it is dropped; the next one is tagged.
 */
async function learnSource(entry: SourcedLogEntry): Promise<void> {
  // Hold the line that triggered this, and any that arrive while the lookup is
  // in flight. Dropping them would lose a service that logs once and falls
  // quiet — and lose it from the filter and from copy too, not just the view.
  unknownSourceQueue.push({ entry, scope: loadSeq });
  if (refreshingSources || !groupSources) return;
  refreshingSources = true;
  try {
    for (;;) {
      const scope = loadSeq;
      const sources = await window.api.getMergedSources(mergedGroupId);
      if (!groupSources) return;
      if (scope === loadSeq) {
        for (const source of sources) groupSources.set(source.id, source);
        break;
      }
      // The view moved on while we waited. These names belong to a scope that
      // is no longer on screen: writing them into the current map would label
      // live rows with another group's services. The lines they were fetched
      // for go with them — the new scope's snapshot supersedes that buffer.
      const waiting = unknownSourceQueue.filter((q) => q.scope === loadSeq);
      unknownSourceQueue.length = 0;
      if (!waiting.length) return;
      unknownSourceQueue.push(...waiting); // arrived after the switch: still ours
    }
  } finally {
    refreshingSources = false;
  }
  const held = unknownSourceQueue.splice(0);
  for (const queued of held) {
    // Anything still unknown after a refresh really is not ours.
    if (queued.scope === loadSeq && groupSources?.has(queued.entry.srcId))
      deliverMerged(queued.entry);
  }
}

/** The paused-or-not path a merged line takes once its source is known. */
function deliverMerged(entry: SourcedLogEntry): void {
  if (pausedEl.checked) {
    pendingQueue.push(entry);
    statusEl.textContent = `Pausado (+${pendingQueue.length})`;
    return;
  }
  pushEntry(entry);
}

/** Draw the window around an entry, scroll to it and mark it. */
function flashEntry(entryIndex: number): void {
  const row = renderAroundEntry(entryIndex);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation if it is already running
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
  const entryIndex = Number(row.dataset.eidx);
  filterEl.value = '';
  // Clearing the filter re-renders, so the row handed in here is discarded —
  // the entry index is what survives, and the window is rebuilt around it.
  setLevelFilter([]);
  // Always respond, even when nothing was filtered. A control that looks
  // pressable and answers with silence teaches you to stop pressing it; with
  // no filter on, centring and flashing the line is still a real answer.
  autoscrollEl.checked = false; // otherwise the tail yanks us away again
  if (Number.isFinite(entryIndex)) flashEntry(entryIndex);
}

/** Replace the level pin outright — entry points set what they want to see. */
function setLevelFilter(levels: readonly SilenceLevel[]): void {
  levelFilter.clear();
  for (const level of levels) levelFilter.add(level);
  renderLevelChips();
  applyFilter();
}

/**
 * Build one row. Pure construction: it neither appends nor trims, so the
 * window layer can render any slice of the buffer, repeatedly, without the
 * side effects that used to be tangled in here.
 */
function buildRow(entry: LogEntry, entryIndex: number): HTMLElement {
  const div = document.createElement('div');
  const classes = ['line', entry.stream];
  if (entry.level) classes.push(entry.level);
  if (entry.silenced) classes.push('silenced');
  div.className = classes.join(' ');
  div.dataset.line = entry.line;
  div.dataset.level = levelOf(entry);
  div.dataset.ts = String(entry.ts); // handle for jumping between views
  div.dataset.eidx = String(entryIndex); // position in `entries`
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

  if (selected.has(entryIndex)) div.classList.add('selected');
  return div;
}

// ─────────────────── Log buffer and render window ────────────────
/*
 * Lines live in `entries`; only a window of them is ever in the DOM.
 *
 * Before, every retained line was a row, so the retention setting doubled as a
 * DOM budget and 20 000 lines locked the window up. Now retention is memory —
 * cheap — and the DOM holds a few hundred rows around where you are looking,
 * extended at whichever edge you approach. `visible` is the filtered view of
 * `entries`, so filtering searches everything held rather than only what
 * happens to be drawn.
 */
let entries: LogEntry[] = [];
/** Indices into `entries` that pass the current filters, in order. */
let visible: number[] = [];
/** Rendered slice of `visible`, inclusive; -1/-2 means nothing rendered. */
let winStart = 0;
let winEnd = -1;
/** Rows rendered on a fresh view, and added per edge as you scroll. */
const WINDOW_ROWS = 600;
const EDGE_CHUNK = 300;
/** How close to an edge counts as approaching it. */
const EDGE_PX = 500;
/** Selection survives re-rendering because it is keyed by entry, not by row. */
const selected = new Set<number>();
let anchorEntry: number | null = null;
/**
 * Lines held in memory. Mirrors what ProcessManager actually keeps for the
 * target on screen — a number only main can give us, since a running process
 * froze its limit at start and a setting edited since does not apply to it.
 * Holding more than main does would let the viewer filter and copy lines the
 * process buffer has already dropped.
 */
let memoryCap = 20_000;
/** The global setting, for views with no override of their own. */
let globalRetention = 20_000;
/**
 * The run our buffer belongs to. `start()` empties main's buffer, so a restart
 * makes every line we hold history that no longer exists behind it.
 */
let watchedStartedAt: number | null = null;

function passesFilter(entry: LogEntry): boolean {
  return matchesFilter(entry);
}

function recomputeVisible(): void {
  visible = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && passesFilter(entry)) visible.push(i);
  }
}

function renderCounts(): void {
  const total = entries.length;
  countsEl.textContent =
    visible.length === total
      ? `${total} líneas`
      : `${visible.length} de ${total} líneas`;
}

/** Replace the DOM with `visible[from..to]`, clamped to what exists. */
function renderWindow(from: number, to: number): void {
  winStart = Math.max(0, from);
  winEnd = Math.min(visible.length - 1, to);
  const fragment = document.createDocumentFragment();
  for (let pos = winStart; pos <= winEnd; pos += 1) {
    const entryIndex = visible[pos];
    if (entryIndex === undefined) continue;
    const entry = entries[entryIndex];
    if (entry) fragment.appendChild(buildRow(entry, entryIndex));
  }
  linesEl.textContent = '';
  linesEl.appendChild(fragment);
  renderCounts();
  // Deliberately no updateScrollButton() here: growTop compensates scrollTop
  // right after rendering, so judging position mid-flight would briefly read
  // "at bottom" and switch auto-scroll back on, yanking the reader to the tail.
}

function renderAtBottom(): void {
  const win = initialWindow(visible.length, WINDOW_ROWS);
  renderWindow(win.start, win.end);
  mainEl.scrollTop = mainEl.scrollHeight;
  updateScrollButton();
}

/** Render around one entry, for landing on a specific line after a jump. */
function renderAroundEntry(entryIndex: number): HTMLElement | null {
  const pos = visible.indexOf(entryIndex);
  if (pos < 0) return null;
  const win = windowAround(pos, visible.length, WINDOW_ROWS);
  renderWindow(win.start, win.end);
  return (
    linesEl.querySelector<HTMLElement>(`.line[data-eidx="${entryIndex}"]`) ??
    null
  );
}

/** Extend upward, holding the viewport still. */
function growTop(): void {
  if (winStart === 0) return;
  const before = mainEl.scrollHeight;
  const win = extendTop(
    { start: winStart, end: winEnd },
    visible.length,
    EDGE_CHUNK,
    WINDOW_ROWS,
  );
  renderWindow(win.start, win.end);
  // Measured rather than computed: rows wrap, so their heights are not known
  // ahead of time. The delta is exactly how far the content moved down.
  mainEl.scrollTop += mainEl.scrollHeight - before;
  updateScrollButton();
}

/** Extend downward, dropping from the top if the DOM budget is spent. */
function growBottom(): void {
  if (winEnd >= visible.length - 1) return;
  const before = mainEl.scrollHeight;
  const win = extendBottom(
    { start: winStart, end: winEnd },
    visible.length,
    EDGE_CHUNK,
    WINDOW_ROWS,
  );
  const droppingTop = win.start > winStart;
  renderWindow(win.start, win.end);
  if (droppingTop) mainEl.scrollTop -= before - mainEl.scrollHeight;
  updateScrollButton();
}

/**
 * Forget lines queued while paused. They describe the buffer we are about to
 * replace, so they go BEFORE we ask main for the new one — never after: main
 * snapshots and resubscribes in the same tick, so a line is in one or the
 * other and never both. Dropping the queue once the snapshot lands would throw
 * away everything that arrived in between.
 */
function dropPendingQueue(): void {
  pendingQueue.length = 0;
  // A "Pausado (+N)" counting a queue that no longer exists would be a lie.
  statusEl.textContent = pausedEl.checked ? 'Pausado' : '';
}

/** Point the view at a fresh set of lines (a scope switch or a snapshot). */
function resetBuffer(next: LogEntry[]): void {
  entries = next;
  selected.clear();
  anchorEntry = null;
  recomputeVisible();
  renderAtBottom();
  reportSelection();
}

/**
 * A line that just arrived. It only reaches the DOM when the view is already
 * at the bottom: scrolled back, you are reading history and must not be
 * yanked forward.
 */
function pushEntry(entry: LogEntry): void {
  if (entry.silenced) pushMutedLine(entry);
  // A selection detaches the view from the tail. Otherwise every arriving line
  // slides the window and drops rows off the top — with the DOM budget down
  // from the old 20 000 to a few hundred that happens constantly, so a
  // selection visibly ate itself row by row while its owner watched.
  // The lines still accumulate in the buffer; ↓ or clearing the selection
  // returns to following them.
  const wasAtEnd = winEnd >= visible.length - 1 && selected.size === 0;
  entries.push(entry);
  if (entries.length > memoryCap + EDGE_CHUNK && trimMemory()) {
    // A trim rebuilds `visible` and the window from scratch, this entry
    // included. Carrying on would push its index a second time and append a
    // second row for it — one duplicate per trim, for the life of the view.
    renderCounts();
    return;
  }
  const entryIndex = entries.length - 1;
  if (!passesFilter(entry)) {
    renderCounts();
    return;
  }
  visible.push(entryIndex);
  if (!wasAtEnd) {
    renderCounts();
    return;
  }
  linesEl.appendChild(buildRow(entry, entryIndex));
  winEnd = visible.length - 1;
  while (
    linesEl.childElementCount > WINDOW_ROWS + EDGE_CHUNK &&
    linesEl.firstChild
  ) {
    linesEl.removeChild(linesEl.firstChild);
    winStart += 1;
  }
  if (autoscrollEl.checked) mainEl.scrollTop = mainEl.scrollHeight;
  renderCounts();
  updateScrollButton();
}

/**
 * Drop the oldest lines once memory is past its cap, in one batch so the
 * re-indexing below is rare. Every index in `visible`, in the selection and in
 * the window shifts, so they are all rebased together.
 */
function trimMemory(): boolean {
  const drop = entries.length - memoryCap;
  if (drop <= 0) return false;
  // How far the window has to slide, and whether it was following the tail —
  // decided BEFORE the shift, while the old indices still mean something.
  const droppedVisible = visible.filter((index) => index < drop).length;
  const wasFollowing = winEnd >= visible.length - 1;

  entries = entries.slice(drop);
  const rebased = new Set<number>();
  for (const index of selected) {
    if (index - drop >= 0) rebased.add(index - drop);
  }
  selected.clear();
  for (const index of rebased) selected.add(index);
  anchorEntry =
    anchorEntry === null || anchorEntry - drop < 0 ? null : anchorEntry - drop;
  recomputeVisible();

  // Only jump to the tail if that is where the reader already was. Forcing it
  // would drag anyone scrolled back to the end every few hundred lines.
  if (wasFollowing) {
    renderAtBottom();
    return true;
  }
  const win = clampWindow(
    winStart - droppedVisible,
    winEnd - droppedVisible,
    visible.length,
  );
  renderWindow(win.start, win.end);
  updateScrollButton();
  return true;
}

function applyFilter(): void {
  filterRe = buildFilter(filterEl.value);
  recomputeVisible();
  renderAtBottom();
  reportSelection();
}

function flushQueue(): void {
  if (pausedEl.checked) return;
  while (pendingQueue.length) {
    const entry = pendingQueue.shift();
    if (entry) pushEntry(entry);
  }
}

// Approaching either edge extends the window there. No spinner and no gap:
// the lines are already in memory, this only decides what is drawn.
mainEl.addEventListener('scroll', () => {
  if (mainEl.scrollTop < EDGE_PX) growTop();
  else if (
    mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight <
    EDGE_PX
  )
    growBottom();
});

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
  resetBuffer([]);
  dropPendingQueue(); // resuming would re-add the very lines just cleared
});

// ─────────────────────── Line selection & copy ───────────────────
// Selection lives in the DOM (`.line.selected`) so trimming the buffer or
// re-filtering can never leave it pointing at rows that are gone.

/*
 * Selection is keyed by ENTRY, not by row: rows come and go as the window
 * moves, so a DOM-based selection would silently lose whatever scrolled out.
 * Positions handed to applySelection are positions in `visible`, which is what
 * "the line above this one" means to someone reading a filtered log.
 */
function repaintSelection(): void {
  for (const node of Array.from(linesEl.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const index = Number(node.dataset.eidx);
    node.classList.toggle('selected', selected.has(index));
  }
  reportSelection();
}

function selectionAsPositions(): Selection {
  const positions = new Set<number>();
  for (let pos = 0; pos < visible.length; pos += 1) {
    const index = visible[pos];
    if (index !== undefined && selected.has(index)) positions.add(pos);
  }
  const anchor =
    anchorEntry === null
      ? null
      : (() => {
          const pos = visible.indexOf(anchorEntry);
          return pos < 0 ? null : pos;
        })();
  return { selected: positions, anchor };
}

function commitSelection(next: Selection): void {
  selected.clear();
  for (const pos of next.selected) {
    const index = visible[pos];
    if (index !== undefined) selected.add(index);
  }
  anchorEntry = next.anchor === null ? null : (visible[next.anchor] ?? null);
  repaintSelection();
}

function reportSelection(): void {
  const count = selected.size;
  copyBtn.title = count ? `Copiar ${count} línea(s) seleccionada(s)` : 'Copiar';
  if (count) statusEl.textContent = `${count} seleccionada(s)`;
  else if (pausedEl.checked) statusEl.textContent = 'Pausado';
  else statusEl.textContent = '';
}

function clearSelection(): void {
  selected.clear();
  anchorEntry = null;
  repaintSelection();
  updateScrollButton(); // following may resume now
}

function selectAllVisible(): void {
  selected.clear();
  for (const index of visible) selected.add(index);
  anchorEntry = visible[0] ?? null;
  repaintSelection();
}

/** Copy text for entry indices, straight from the buffer. */
function entriesToText(indices: readonly number[]): string {
  return indices
    .map((index) => {
      const entry = entries[index];
      if (!entry) return '';
      return `${fmtTime(entry.ts)} ${stripAnsi(entry.line)}`;
    })
    .filter(Boolean)
    .join('\n');
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
  const entryIndex = Number(row.dataset.eidx);
  const pos = visible.indexOf(entryIndex);
  if (pos < 0) return;
  commitSelection(
    applySelection(selectionAsPositions(), pos, selectModeFor(ev)),
  );
});

// Clicking the empty space under the last line drops the selection.
mainEl.addEventListener('click', (ev) => {
  if (!closestElement(ev.target, '.line')) clearSelection();
});

async function copyEntries(indices: readonly number[]): Promise<void> {
  try {
    await navigator.clipboard.writeText(entriesToText(indices));
    statusEl.textContent = `Copiado ✓ (${indices.length})`;
    setTimeout(reportSelection, 1500);
  } catch (err) {
    statusEl.textContent = 'Error al copiar';
  }
}

// With a selection the button copies just that; with none, everything the
// filter leaves — the whole filtered buffer, not merely the drawn window.
copyBtn.addEventListener('click', () => {
  const picked = [...selected].sort((a, b) => a - b);
  void copyEntries(picked.length ? picked : visible);
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

/**
 * At the end of the LOG, not merely at the end of what is drawn. With a window
 * over the buffer those stopped being the same thing: scrolled back, the bottom
 * of the DOM is the bottom of the window, and there are newer lines past it.
 */
function isAtBottom(): boolean {
  if (winEnd < visible.length - 1) return false;
  return (
    mainEl.scrollTop + mainEl.clientHeight >=
    mainEl.scrollHeight - SCROLL_THRESHOLD
  );
}

function updateScrollButton(): void {
  if (!scrollBtn) return;
  const atBottom = isAtBottom();
  scrollBtn.classList.toggle('visible', !atBottom);
  // Never resume following while lines are selected: that is the one moment
  // the reader has said, by picking rows, that they are not watching the tail.
  if (atBottom && !autoscrollEl.checked && selected.size === 0) {
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
  // Move the WINDOW to the tail first. Scrolling the container alone would stop
  // at the end of the drawn slice, which is what this button appeared to do.
  renderAtBottom();
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
    if (!selected.size) return;
    e.preventDefault();
    void copyEntries([...selected].sort((a, b) => a - b));
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
  // Guard the rebuild. This runs on every sidebar repaint, including the
  // one-second uptime tick, and the counters are BUTTONS: replacing one between
  // mousedown and mouseup means the browser never fires the click, so pressing
  // a counter silently does nothing. It also drops any pending tooltip anchor.
  // The runtime text changes every second, so the signature has to cover it.
  const runtimeNow = runtimeOf(item);
  const signature = [
    item.warnCount,
    item.errorCount,
    item.lineCount,
    runtimeNow ? `${runtimeNow.text}/${runtimeNow.live}` : '',
  ].join('|');
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
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
  syncWatched();
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
  // Update the BUFFER, not just the drawn rows. A row scrolled out of the
  // window would otherwise come back built from a stale `silenced` flag.
  let changed = false;
  for (const entry of entries) {
    const orig = entry.originalLevel;
    if (!orig) continue;
    const list = sp[orig] || [];
    const isSilenced = list.some((pattern) =>
      clientMatchesPattern(pattern, stripAnsi(entry.line)),
    );
    if (entry.silenced === isSilenced) continue;
    entry.silenced = isSilenced;
    entry.level = isSilenced ? null : orig;
    changed = true;
  }
  if (changed) {
    renderWindow(winStart, winEnd);
    updateScrollButton();
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
togglePanelBtn.addEventListener('click', () => {
  // Silencing is per service. In a merged scope there is no single command to
  // act on: patterns would list empty (reading as "nothing is silenced") and a
  // typed pattern would be cleared from the input and dropped without a word.
  if (groupSources) {
    statusEl.textContent = 'Los silenciados son por servicio: elige uno';
    setTimeout(reportSelection, 2500);
    return;
  }
  setDrawer(!drawerOpen());
});

// ─────────────────────── Switching between logs ──────────────────
/**
 * Merge several services into one stream: a whole group, or every group when
 * `groupId` is null (the generic telemetry view). Each row is tagged with its
 * source, so a mixed feed stays readable without splitting the window.
 * Selecting an individual service afterwards drops back to single mode.
 */
async function selectMergedLog(groupId: string | null): Promise<void> {
  processId = null;
  unknownSourceQueue.length = 0; // held lines belong to the old scope
  clearMutedFeeds(); // rows from the previous scope would target the wrong command
  mergedIsAll = groupId === null;
  mergedGroupId = groupId;
  resetBuffer([]);
  dropPendingQueue();
  currentTarget = null;
  currentGroupId = null;
  currentCommandId = null;
  setDrawer(false); // silencing is per-service; it has no meaning here

  memoryCap = globalRetention; // merged snapshots are capped globally
  const token = ++loadSeq;
  const res = await window.api.getMergedLogs(groupId);
  if (token !== loadSeq) return; // a newer load won the race
  groupSources = new Map(res.sources.map((s) => [s.id, s]));
  _logsDisplayName = groupId ? 'todos' : '';
  _logsGroupName = res.groupName;
  const heading = groupId ? `Logs — ${res.groupName} · todos` : 'Telemetría';
  setText(titleEl, heading);
  document.title = heading;
  uptimeBadgeEl.classList.remove('visible');
  runBtn.style.display = 'none';
  renderLevelChips();

  resetBuffer([...res.lines]);
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
  mergedGroupId = null;
  unknownSourceQueue.length = 0; // held lines belong to the old scope
  clearMutedFeeds(); // rows from the previous scope would target the wrong command
  mergedIsAll = false;
  for (const summary of Array.from(
    sideTreeEl.querySelectorAll<HTMLElement>('.side-group'),
  ))
    summary.classList.remove('viewing');
  sideTreeEl
    .querySelector<HTMLElement>('.side-all')
    ?.classList.remove('active');
  resetBuffer([]);
  dropPendingQueue();
  currentTarget = null;
  currentGroupId = null;
  currentCommandId = null;
  muteWarnEl.checked = false;
  muteErrEl.checked = false;
  if (filter !== undefined) filterEl.value = filter;
  filterRe = buildFilter(filterEl.value);

  // getLogs also points main's live stream at this buffer, atomically.
  const token = ++loadSeq;
  const res = await window.api.getLogs(id);
  if (token !== loadSeq) return; // a newer load won the race
  memoryCap = res.logLimit; // whatever main kept for it, not what config says now
  watchedStartedAt = res.commandState.startedAt;

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

  resetBuffer([...res.lines]);
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
  // Retention bounds what the renderer HOLDS; the window decides what it draws.
  const settings = await window.api.getSettings();
  globalRetention = settings?.maxLogLines || DEFAULT_MAX_LOG_LINES;
  memoryCap = globalRetention;
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
    // A service can appear AFTER the view opened — a pre-script running for
    // the first time. Main forwards it because the scope matches, so an
    // unknown id here means our source list is stale, not that the line is
    // foreign: learn the name, then show it.
    const sourced = { ...payload.entry, srcId: payload.id };
    if (!groupSources.has(payload.id)) {
      void learnSource(sourced);
      return;
    }
    deliverMerged(sourced);
    return;
  }
  if (payload.id !== processId) return;
  if (pausedEl.checked) {
    pendingQueue.push(payload.entry);
    statusEl.textContent = `Pausado (+${pendingQueue.length})`;
    return;
  }
  pushEntry(payload.entry);
});

/**
 * Follow the watched process across a restart and across a retention change.
 * Both leave the viewer holding lines main has already dropped — offering them
 * to the filter and to copy — and neither announces itself as anything more
 * than a state change.
 */
function syncWatched(): void {
  if (!processId) return;
  const item = sideData
    .flatMap((group) => group.items)
    .find((candidate) => candidate.id === processId);
  if (!item) return;
  if (item.startedAt !== watchedStartedAt && item.startedAt !== null) {
    void reloadWatched(); // a new run: the previous one's lines are gone
    return;
  }
  if (item.logLimit === memoryCap) return;
  memoryCap = item.logLimit;
  if (entries.length > memoryCap + EDGE_CHUNK) trimMemory();
}

/** Replace the buffer with main's, for when ours describes a run that ended. */
async function reloadWatched(): Promise<void> {
  const id = processId;
  if (!id) return;
  // The queue holds the finished run's lines, and the '▶ start' of the new one
  // if it landed before we got here — the snapshot carries that one already.
  dropPendingQueue();
  const token = ++loadSeq;
  const res = await window.api.getLogs(id);
  // The view may have moved on, and a reload must not outlive its target.
  if (token !== loadSeq || processId !== id) return;
  watchedStartedAt = res.commandState.startedAt;
  memoryCap = res.logLimit;
  resetBuffer([...res.lines]);
}

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
