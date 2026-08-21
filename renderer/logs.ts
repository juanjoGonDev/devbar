import { byId, requireElement } from './dom.js';
import { canRun, dotClass, isRunning, runtimeOf } from './log-status.js';
import type { LogEntry } from '../src/domain-types.js';
import type {
  LogListGroup,
  LogListItem,
  LogsTarget,
  SilenceLevel,
} from '../src/ipc-contract.js';

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
const scrollBtn = byId<HTMLButtonElement>('scroll-bottom', HTMLButtonElement);
const runBtn = byId<HTMLButtonElement>('run-toggle', HTMLButtonElement);
const detachBtn = byId<HTMLButtonElement>('detach', HTMLButtonElement);
const sideTreeEl = byId<HTMLElement>('side-tree', HTMLElement);
const sideFilterEl = byId<HTMLInputElement>('side-filter', HTMLInputElement);

// ─────────────────────────── State ───────────────────────────────
let processId = params.get('id');
// Current resolved target (group + command/action)
let currentTarget: LogsTarget | null = null;
// groupId + commandId extracted from processId for silence ops
let currentGroupId: string | null = null;
let currentCommandId: string | null = null;
let globalMaxLogLines = 2000;
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

function matchesFilter(entry: LogEntry): boolean {
  if (!filterRe) return true;
  return filterRe.test(stripAnsi(entry.line));
}

function appendLine(entry: LogEntry): void {
  const div = document.createElement('div');
  const classes = ['line', entry.stream];
  if (entry.level) classes.push(entry.level);
  if (entry.silenced) classes.push('silenced');
  div.className = classes.join(' ');
  div.dataset.line = entry.line;
  if (entry.originalLevel) div.dataset.originalLevel = entry.originalLevel;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(entry.ts);
  div.appendChild(ts);

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
    const ok = !filterRe || filterRe.test(text);
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

copyBtn.addEventListener('click', async () => {
  const text = Array.from(linesEl.children)
    .filter((n) => !n.classList.contains('hidden'))
    .map((node) => {
      const ts = node.querySelector<HTMLElement>('.ts')?.textContent ?? '';
      const body = node.querySelector<HTMLElement>('.body')?.textContent ?? '';
      return `${ts} ${body}`;
    })
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = 'Copiado ✓';
    setTimeout(() => {
      if (!pausedEl.checked) statusEl.textContent = '';
    }, 1500);
  } catch (err) {
    statusEl.textContent = 'Error al copiar';
  }
});

detachBtn.addEventListener('click', () => {
  if (processId) window.api.openLogs({ processId, detached: true });
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
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    filterEl.focus();
    filterEl.select();
  }
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
  titleEl.textContent = base;
  if (runtime) {
    uptimeBadgeEl.textContent = runtime.live
      ? runtime.text
      : `último: ${runtime.text}`;
    uptimeBadgeEl.classList.add('visible');
    document.title = `${base} · ${runtime.text}`;
  } else {
    uptimeBadgeEl.textContent = '';
    uptimeBadgeEl.classList.remove('visible');
    document.title = base;
  }
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

function renderBadges(host: HTMLElement, item: LogListItem): void {
  host.textContent = '';
  if (item.warnCount > 0) {
    const b = document.createElement('span');
    b.className = 'b warn';
    b.title = `${item.warnCount} warning(s)`;
    b.textContent = `⚠ ${item.warnCount}`;
    host.appendChild(b);
  }
  if (item.errorCount > 0) {
    const b = document.createElement('span');
    b.className = 'b err';
    b.title = `${item.errorCount} error(es)`;
    b.textContent = `⛔ ${item.errorCount}`;
    host.appendChild(b);
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

function renderSidebar(): void {
  sideTreeEl.textContent = '';
  if (!sideData.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No hay grupos configurados.';
    sideTreeEl.appendChild(empty);
    return;
  }
  for (const group of sideData) {
    const details = document.createElement('details');
    details.className = 'side-group';
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
    gIco.textContent = group.groupIcon || '📁';
    const gName = document.createElement('span');
    gName.className = 'g-name';
    gName.textContent = group.groupName;
    summary.append(chevron, gIco, gName);
    details.appendChild(summary);
    for (const item of group.items) {
      const row = buildSideItem(item);
      paintSideItem(row, item);
      details.appendChild(row);
    }
    sideTreeEl.appendChild(details);
  }
  applySideFilter();
}

/** Repaint in place when only the live numbers changed — keeps scroll & focus. */
function repaintSidebar(): boolean {
  for (const group of sideData) {
    for (const item of group.items) {
      const row = sideTreeEl.querySelector<HTMLElement>(
        `.side-item[data-id="${CSS.escape(item.id)}"]`,
      );
      if (!row) return false;
      paintSideItem(row, item);
    }
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

togglePanelBtn.addEventListener('click', () => {
  if (!currentGroupId || !currentCommandId) return;
  window.api.openSilenced(currentGroupId, currentCommandId);
});

// ─────────────────────── Switching between logs ──────────────────
async function selectLog(id: string, filter?: string): Promise<void> {
  processId = id;
  linesEl.textContent = '';
  visibleCount = 0;
  pendingQueue.length = 0;
  countsEl.textContent = '0 líneas';
  statusEl.textContent = pausedEl.checked ? 'Pausado' : '';
  currentTarget = null;
  currentGroupId = null;
  currentCommandId = null;
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
  globalMaxLogLines = (settings && settings.maxLogLines) || 2000;
  if (initialFilter) filterEl.value = initialFilter;
  await refreshSidebar();
  if (processId) {
    await selectLog(processId, initialFilter || undefined);
  } else {
    titleEl.textContent = 'Logs (sin proceso)';
  }
})();

// Main asks the shared window to switch (or a detached one to re-filter).
window.api.onLogsSelect(({ processId: pid, filter }) => {
  if (isDetached) {
    if (pid !== processId || filter === undefined) return;
    filterEl.value = filter;
    applyFilter();
    return;
  }
  void selectLog(pid, filter);
});

window.api.onLog((payload) => {
  if (!payload || payload.id !== processId) return;
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
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSidebar();
  }, 250);
});
