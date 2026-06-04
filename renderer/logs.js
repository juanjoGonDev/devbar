// ───────────────────────── ANSI parsing ──────────────────────────
const ANSI_ANY_RE = /\x1b\[[\d;?]*[a-zA-Z]/g;
const ANSI_SGR_RE = /\x1b\[([\d;?]*)([a-zA-Z])/g;

const PALETTE_FG = {
  30: '#3a3a3c', 31: '#ff6961', 32: '#5fdb86', 33: '#ffd60a',
  34: '#5e9eff', 35: '#d97cf2', 36: '#7adfff', 37: '#e5e5e7',
  90: '#8e8e93', 91: '#ff8a8a', 92: '#7eea9f', 93: '#ffe066',
  94: '#85b6ff', 95: '#e29bf6', 96: '#a3e8ff', 97: '#ffffff',
};

const PALETTE_BG = {
  40: '#3a3a3c', 41: '#ff453a', 42: '#30d158', 43: '#a07a00',
  44: '#0a84ff', 45: '#9543c1', 46: '#0090a8', 47: '#dcdce0',
  100: '#5e5e63', 101: '#ff6961', 102: '#5fdb86', 103: '#ffe066',
  104: '#5e9eff', 105: '#d97cf2', 106: '#7adfff', 107: '#f5f5f7',
};

function color256(n) {
  if (n < 16) {
    const map = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
    return PALETTE_FG[map[n]] || '#e5e5e7';
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
  return `rgb(${ramp[r]},${ramp[g]},${ramp[b]})`;
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

function spanFor(text, style) {
  if (!text) return '';
  const css = [];
  if (style.fg) css.push(`color:${style.fg}`);
  if (style.bg) css.push(`background:${style.bg}`);
  if (style.bold) css.push('font-weight:600');
  if (style.dim) css.push('opacity:0.65');
  if (style.italic) css.push('font-style:italic');
  if (style.underline) css.push('text-decoration:underline');
  if (!css.length) return escapeHtml(text);
  return `<span style="${css.join(';')}">${escapeHtml(text)}</span>`;
}

function clamp255(n) {
  return Math.max(0, Math.min(255, n | 0));
}

function applyCodes(codeStr, style) {
  const codes = (codeStr || '').split(';').map((s) => (s === '' ? 0 : parseInt(s, 10)));
  let i = 0;
  while (i < codes.length) {
    const c = isNaN(codes[i]) ? 0 : codes[i];
    if (c === 0) {
      style.fg = null; style.bg = null;
      style.bold = false; style.dim = false;
      style.italic = false; style.underline = false;
    } else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 22) { style.bold = false; style.dim = false; }
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 39) style.fg = null;
    else if (c === 49) style.bg = null;
    else if (PALETTE_FG[c]) style.fg = PALETTE_FG[c];
    else if (PALETTE_BG[c]) style.bg = PALETTE_BG[c];
    else if (c === 38 && codes[i + 1] === 5) {
      style.fg = color256(codes[i + 2] || 0); i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      style.fg = `rgb(${clamp255(codes[i + 2])},${clamp255(codes[i + 3])},${clamp255(codes[i + 4])})`;
      i += 4;
    } else if (c === 48 && codes[i + 1] === 5) {
      style.bg = color256(codes[i + 2] || 0); i += 2;
    } else if (c === 48 && codes[i + 1] === 2) {
      style.bg = `rgb(${clamp255(codes[i + 2])},${clamp255(codes[i + 3])},${clamp255(codes[i + 4])})`;
      i += 4;
    }
    i += 1;
  }
}

function ansiToHtml(line) {
  const cleaned = line.replace(/\r/g, '');
  const out = [];
  const style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
  ANSI_SGR_RE.lastIndex = 0;
  let lastIndex = 0;
  let m;
  while ((m = ANSI_SGR_RE.exec(cleaned)) !== null) {
    const text = cleaned.slice(lastIndex, m.index);
    if (text) out.push(spanFor(text, style));
    if (m[2] === 'm') applyCodes(m[1], style);
    lastIndex = ANSI_SGR_RE.lastIndex;
  }
  out.push(spanFor(cleaned.slice(lastIndex), style));
  return out.join('');
}

function stripAnsi(s) {
  return (s || '').replace(ANSI_ANY_RE, '');
}

// ────────────────────────── DOM refs ─────────────────────────────
const params = new URLSearchParams(location.search);
// Support both old --service-id= and new --process-id= argument
const processId = params.get('id');
// Pre-set filter if passed as a query param (e.g. from counter-button click)
const initialFilter = params.get('filter') || '';

const titleEl = document.getElementById('title');
const uptimeBadgeEl = document.getElementById('uptime-badge');
const linesEl = document.getElementById('lines');
const filterEl = document.getElementById('filter');
const autoscrollEl = document.getElementById('autoscroll');
const pausedEl = document.getElementById('paused');
const clearBtn = document.getElementById('clear');
const copyBtn = document.getElementById('copy');
const countsEl = document.getElementById('counts');
const statusEl = document.getElementById('status');
const mainEl = document.querySelector('main');
const muteWarnEl = document.getElementById('mute-warn');
const muteErrEl = document.getElementById('mute-err');
const togglePanelBtn = document.getElementById('toggle-silenced');
const scrollBtn = document.getElementById('scroll-bottom');

// ────────────────────── Uptime for logs window ───────────────────
// startedAt: timestamp (ms) of the running process, or null if stopped
let _logsStartedAt = null;
let _logsDisplayName = '';
let _logsGroupName = '';

function updateLogsUptime() {
  if (!_logsStartedAt) return;
  const elapsed = Date.now() - _logsStartedAt;
  const text = formatUptime(elapsed);
  if (uptimeBadgeEl) {
    uptimeBadgeEl.textContent = text;
    uptimeBadgeEl.style.display = 'inline';
  }
  const base = _logsGroupName
    ? `Logs — ${_logsGroupName} · ${_logsDisplayName}`
    : `Logs — ${_logsDisplayName}`;
  document.title = `${base} · ${text}`;
  titleEl.textContent = base;
}

// Single top-level interval — started once the script loads
const _logsUptimeInterval = setInterval(updateLogsUptime, 1000);

// ─────────────────────────────────────────────────────────────────

// Current resolved target (group + command/action)
let currentTarget = null;
// groupId + commandId extracted from processId for silence ops
let currentGroupId = null;
let currentCommandId = null;

let RENDER_LIMIT = 2000;
let visibleCount = 0;
let pendingQueue = [];
let filterRe = null;

function fmtTime(ts) {
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

function buildFilter(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new RegExp(trimmed, 'i');
  } catch (_) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
}

function matchesFilter(entry) {
  if (!filterRe) return true;
  return filterRe.test(stripAnsi(entry.line));
}

function appendLine(entry) {
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

  if ((entry.originalLevel === 'warn' || entry.originalLevel === 'error') && currentCommandId) {
    const btn = document.createElement('button');
    btn.className = 'silence-btn';
    btn.textContent = entry.silenced ? '🔔' : '🔕';
    btn.title = entry.silenced
      ? 'Quitar silencio (esta línea)'
      : 'Silenciar este patrón (matchea por substring)';
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const lvl = entry.originalLevel;
      const cleaned = stripAnsi(entry.line).trim();
      // Build a regex pattern when possible so it matches across timestamp changes
      const pattern = (window.api.buildSilencePattern && cleaned)
        ? window.api.buildSilencePattern(cleaned)
        : cleaned;
      if (entry.silenced) {
        // Try removing the built pattern first; then fall back to literal cleaned.
        // removeSilencePattern is a no-op when the pattern is not found.
        if (pattern && pattern !== cleaned) {
          await window.api.removeSilencePattern(currentGroupId, currentCommandId, lvl, pattern);
        }
        await window.api.removeSilencePattern(currentGroupId, currentCommandId, lvl, cleaned);
      } else {
        await window.api.addSilencePattern(currentGroupId, currentCommandId, lvl, pattern || cleaned);
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

function applyFilter() {
  filterRe = buildFilter(filterEl.value);
  for (const node of linesEl.children) {
    const text = stripAnsi(node.dataset.line || '');
    const ok = !filterRe || filterRe.test(text);
    node.classList.toggle('hidden', !ok);
  }
  if (autoscrollEl.checked) {
    mainEl.scrollTop = mainEl.scrollHeight;
  }
}

function flushQueue() {
  if (pausedEl.checked) return;
  while (pendingQueue.length) {
    appendLine(pendingQueue.shift());
  }
}

filterEl.addEventListener('input', applyFilter);
pausedEl.addEventListener('change', () => {
  statusEl.textContent = pausedEl.checked ? 'Pausado' : '';
  if (!pausedEl.checked) flushQueue();
});

clearBtn.addEventListener('click', () => {
  linesEl.innerHTML = '';
  visibleCount = 0;
  countsEl.textContent = '0 líneas';
});

copyBtn.addEventListener('click', async () => {
  const text = Array.from(linesEl.children)
    .filter((n) => !n.classList.contains('hidden'))
    .map((n) => `${n.querySelector('.ts').textContent} ${n.querySelector('.body').textContent}`)
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

const SCROLL_THRESHOLD = 4;

function isAtBottom() {
  return mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - SCROLL_THRESHOLD;
}

function updateScrollButton() {
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

if (scrollBtn) {
  scrollBtn.addEventListener('click', () => {
    mainEl.scrollTop = mainEl.scrollHeight;
    autoscrollEl.checked = true;
    updateScrollButton();
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    filterEl.focus();
    filterEl.select();
  }
});

function applyTargetSnapshot(target) {
  if (!target) return;
  currentTarget = target;
  // Only commands have silence settings
  if (target.kind === 'command' && target.target) {
    const cmd = target.target;
    muteWarnEl.checked = !!cmd.silenceWarnings;
    muteErrEl.checked = !!cmd.silenceErrors;
  }
}


function clientMatchesPattern(p, lineText) {
  if (!p) return false;
  // Mirror process-manager heuristic: backslash present → try as regex.
  if (!p.includes('\\')) return lineText.includes(p);
  try {
    return new RegExp(p, 'i').test(lineText);
  } catch (_) {
    return lineText.includes(p);
  }
}

function rerenderExistingLines() {
  if (!currentTarget || currentTarget.kind !== 'command' || !currentTarget.target) return;
  const sp = currentTarget.target.silencedPatterns || { warn: [], error: [] };
  for (const node of linesEl.children) {
    const orig = node.dataset.originalLevel;
    if (!orig) continue;
    const list = sp[orig] || [];
    const lineText = stripAnsi(node.dataset.line || '');
    const isSilenced = list.some((p) => clientMatchesPattern(p, lineText));
    node.classList.toggle('silenced', isSilenced);
    node.classList.toggle('warn', orig === 'warn' && !isSilenced);
    node.classList.toggle('error', orig === 'error' && !isSilenced);
    const btn = node.querySelector('.silence-btn');
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
    window.api.setCommandSilence(currentGroupId, currentCommandId, 'warn', muteWarnEl.checked);
  }
});
muteErrEl.addEventListener('change', () => {
  if (currentGroupId && currentCommandId) {
    window.api.setCommandSilence(currentGroupId, currentCommandId, 'error', muteErrEl.checked);
  }
});

if (togglePanelBtn) {
  togglePanelBtn.addEventListener('click', () => {
    if (!currentGroupId || !currentCommandId) return;
    window.api.openSilenced(currentGroupId, currentCommandId);
  });
}

(async () => {
  if (!processId) {
    titleEl.textContent = 'Logs (sin proceso)';
    return;
  }

  const [res, settings] = await Promise.all([
    window.api.getLogs(processId),
    window.api.getSettings(),
  ]);

  // Resolve render limit: per-command override → global setting → fallback 2000
  const cmdLimit = res && res.target && res.target.target && res.target.target.maxLogLines;
  RENDER_LIMIT = cmdLimit != null ? cmdLimit : ((settings && settings.maxLogLines) || 2000);

  // res.target = { kind, group, target: command|action }
  const target = res.target;
  if (target && target.group && target.target) {
    applyTargetSnapshot(target);
    const displayName = target.target.name || processId;
    _logsDisplayName = displayName;
    _logsGroupName = target.group.name;

    const baseTitle = `Logs — ${target.group.name} · ${displayName}`;
    titleEl.textContent = baseTitle;
    document.title = baseTitle;

    // Set silence op ids
    if (target.kind === 'command') {
      currentGroupId = target.group.id;
      currentCommandId = target.target.id;
    }

    // Check if process is running and has a startedAt timestamp
    // getLogs returns the command state snapshot in res.commandState
    if (res.commandState && res.commandState.status === 'running' && res.commandState.startedAt) {
      _logsStartedAt = res.commandState.startedAt;
      updateLogsUptime();
    }
  } else {
    titleEl.textContent = `Logs — ${processId}`;
  }

  // Apply initial filter before rendering buffered lines so appendLine's
  // matchesFilter check already uses it.
  if (initialFilter) {
    filterEl.value = initialFilter;
    filterRe = buildFilter(initialFilter);
  }

  for (const entry of res.lines) appendLine(entry);
})();

// Subscribe to filter push from main (already-open window scenario)
if (window.api.onLogsSetFilter) {
  window.api.onLogsSetFilter(({ processId: pid, filter }) => {
    if (pid !== processId) return;
    filterEl.value = filter;
    filterEl.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

window.api.onLog((payload) => {
  if (!payload || payload.id !== processId) return;
  if (pausedEl.checked) {
    pendingQueue.push(payload.entry);
    statusEl.textContent = `Pausado (+${pendingQueue.length})`;
    return;
  }
  appendLine(payload.entry);
});

window.api.onUpdate((groupStates) => {
  // Find our command/action in the updated state
  if (!processId || !currentGroupId) return;
  for (const gs of groupStates || []) {
    if (gs.groupId !== currentGroupId) continue;

    // Update uptime tracking based on live command state
    if (currentCommandId) {
      const cs = (gs.commands || []).find((c) => c.commandId === currentCommandId);
      if (cs) {
        if (cs.status === 'running' && cs.startedAt) {
          _logsStartedAt = cs.startedAt;
        } else {
          // Process stopped — clear uptime
          _logsStartedAt = null;
          if (uptimeBadgeEl) {
            uptimeBadgeEl.style.display = 'none';
            uptimeBadgeEl.textContent = '';
          }
          const baseTitle = `Logs — ${_logsGroupName} · ${_logsDisplayName}`;
          titleEl.textContent = baseTitle;
          document.title = baseTitle;
        }
      }
      rerenderExistingLines();
    }
  }
});
