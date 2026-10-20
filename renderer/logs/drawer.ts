/**
 * The silenced panel: the rules that swallow lines, and a draft that shows
 * what it WOULD swallow before it is saved.
 *
 * It lives inside the logs window instead of a separate one so the two are
 * visible together — a rule you cannot inspect is a rule you stop trusting.
 * The draft previews live against the lines already held (count, a few
 * samples, and the rows marked in the log), and hovering a saved rule marks
 * what it is eating the same way. The matching itself is in
 * `silence-preview.ts`, pure; this module only puts it on screen.
 */
import { icon } from '../icon.js';
import { reportSelection } from './status.js';
import {
  checkDraft,
  compilePattern,
  countPatternMatches,
  entryWouldSilence,
  highlightSegments,
  previewPattern,
  type PatternMatcher,
} from './silence-preview.js';
import { buffer } from './buffer.js';
import {
  draftCardEl,
  draftCountEl,
  draftErrorEl,
  draftInputEl,
  draftMetaEl,
  draftRegexBtn,
  draftSamplesEl,
  drawerCloseBtn,
  drawerEl,
  linesEl,
  muteErrEl,
  muteWarnEl,
  patternListEl,
  segErrBtn,
  segErrCountEl,
  segWarnBtn,
  segWarnCountEl,
  setText,
  silencePreviewEl,
  silencePreviewTextEl,
  statusEl,
  toggleLabelEl,
  togglePanelBtn,
} from './elements.js';
import { installSilenceHooks, view } from './view.js';
import { decodeSilencePattern } from '../../src/silence-pattern.js';
import type { LogsTarget, SilenceLevel } from '../../src/ipc-contract.js';

/** Typing settles for this long before the preview re-reads the buffer. */
const PREVIEW_DEBOUNCE_MS = 100;
const LEVEL_KEY = 'devbar.logs.silence-level';

/** Storage can be missing or throw (private mode, blocked site data). */
function loadLevel(): SilenceLevel {
  try {
    return localStorage.getItem(LEVEL_KEY) === 'error' ? 'error' : 'warn';
  } catch {
    return 'warn';
  }
}

function saveLevel(level: SilenceLevel): void {
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {
    // Remembering the level is a convenience; losing it changes nothing else.
  }
}

let level: SilenceLevel = loadLevel();
let draftIsRegex = false;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
/** A saved rule under the pointer wins over the draft until it is left. */
let hovered: string | null = null;

/** Adopt main's view of the shown target, including its silence settings. */
export function applyTargetSnapshot(target: LogsTarget): void {
  if (!target) return;
  view.currentTarget = target;
  // Only commands have silence settings
  if (target.kind === 'command' && target.target) {
    const cmd = target.target;
    muteWarnEl.checked = !!cmd.silenceWarnings;
    muteErrEl.checked = !!cmd.silenceErrors;
  }
  renderToggle();
}

function drawerOpen(): boolean {
  return !drawerEl.hidden;
}

function currentPatterns(): Record<SilenceLevel, string[]> | null {
  const target = view.currentTarget;
  if (!target || target.kind !== 'command' || !target.target) return null;
  const patterns = target.target.silencedPatterns;
  return { warn: patterns?.warn ?? [], error: patterns?.error ?? [] };
}

/** `Silenciados · N`: every rule of the command on screen, both levels. */
function renderToggle(): void {
  const patterns = currentPatterns();
  setText(
    toggleLabelEl,
    patterns
      ? `Silenciados · ${patterns.warn.length + patterns.error.length}`
      : 'Silenciados',
  );
}

// ─────────────────────────── Preview ───────────────────────────

type PreviewSource = 'draft' | 'hover';

/**
 * Mark the rows `matcher` would swallow — the drawn ones now, and through
 * `view.silencePreview` any row built later — and say how many in the footer.
 * `null` takes every mark away.
 */
function showPreview(
  matcher: PatternMatcher | null,
  source: PreviewSource,
): number {
  const previewLevel = level;
  view.silencePreview = matcher
    ? (entry) => entryWouldSilence(entry, previewLevel, matcher)
    : null;
  for (const row of Array.from(
    linesEl.querySelectorAll<HTMLElement>('.line'),
  )) {
    const entry = buffer.entries[Number(row.dataset.eidx)];
    row.classList.toggle(
      'would-silence',
      !!entry && !!view.silencePreview?.(entry),
    );
  }
  if (!matcher) {
    silencePreviewEl.hidden = true;
    return 0;
  }
  const { count } = previewPattern(buffer.entries, previewLevel, matcher);
  silencePreviewEl.hidden = false;
  setText(
    silencePreviewTextEl,
    source === 'draft'
      ? `${count} ${count === 1 ? 'se silenciaría' : 'se silenciarían'} con el patrón nuevo`
      : `${count} ${count === 1 ? 'coincide' : 'coinciden'} con este patrón`,
  );
  return count;
}

function clearDraftPreview(): void {
  draftMetaEl.hidden = true;
  draftSamplesEl.textContent = '';
  if (!hovered) showPreview(null, 'draft');
}

/** Re-read the draft: validity, the inline preview and the marks in the log. */
function updateDraft(): void {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  const check = checkDraft(draftInputEl.value, draftIsRegex);
  const invalid = check.kind === 'invalid';
  draftCardEl.classList.toggle('invalid', invalid);
  draftErrorEl.hidden = !invalid;
  setText(draftErrorEl, invalid ? check.message : '');
  if (check.kind !== 'ok') {
    clearDraftPreview();
    return;
  }
  const matcher = compilePattern(check.pattern);
  const result = previewPattern(buffer.entries, level, matcher);
  draftMetaEl.hidden = false;
  const count = `${result.count}${result.truncated ? '+' : ''}`;
  setText(
    draftCountEl,
    `${count} ${result.count === 1 ? 'línea' : 'líneas'} de este log`,
  );
  draftSamplesEl.textContent = '';
  for (const sample of result.samples) {
    const row = document.createElement('div');
    row.className = 'draft-sample';
    row.title = sample;
    for (const segment of highlightSegments(sample, matcher)) {
      if (segment.hit) {
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        row.appendChild(mark);
      } else row.append(segment.text);
    }
    draftSamplesEl.appendChild(row);
  }
  if (!hovered) showPreview(matcher, 'draft');
}

function scheduleDraft(): void {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(updateDraft, PREVIEW_DEBOUNCE_MS);
}

function setDraftRegex(on: boolean): void {
  draftIsRegex = on;
  draftRegexBtn.setAttribute('aria-pressed', String(on));
}

function clearDraft(): void {
  draftInputEl.value = '';
  setDraftRegex(false);
  updateDraft();
}

function submitDraft(): void {
  const check = checkDraft(draftInputEl.value, draftIsRegex);
  if (check.kind !== 'ok') return;
  if (!view.currentGroupId || !view.currentCommandId) return;
  void window.api.addSilencePattern(
    view.currentGroupId,
    view.currentCommandId,
    level,
    check.pattern,
  );
  clearDraft();
}

// ─────────────────────────── Panel ───────────────────────────

function renderLevel(): void {
  for (const [button, own] of [
    [segWarnBtn, 'warn'],
    [segErrBtn, 'error'],
  ] as const) {
    const on = own === level;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
  }
  for (const row of Array.from(
    drawerEl.querySelectorAll<HTMLElement>('.switch-row'),
  ))
    row.hidden = row.dataset.level !== level;
}

function patternRow(pattern: string, count: number): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'pat';
  const code = document.createElement('code');
  const shown = decodeSilencePattern(pattern).text;
  code.textContent = shown;
  code.title = shown;
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  cnt.textContent = String(count);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'x';
  remove.setAttribute('aria-label', 'Quitar patrón');
  remove.title = 'Quitar patrón';
  remove.append(icon('x'));
  remove.addEventListener('click', () => {
    if (!view.currentGroupId || !view.currentCommandId) return;
    void window.api.removeSilencePattern(
      view.currentGroupId,
      view.currentCommandId,
      level,
      pattern,
    );
  });
  item.addEventListener('mouseenter', () => {
    hovered = pattern;
    showPreview(compilePattern(pattern), 'hover');
  });
  item.addEventListener('mouseleave', () => {
    if (hovered !== pattern) return;
    hovered = null;
    updateDraft(); // back to the draft's marks, or to none
  });
  item.append(code, cnt, remove);
  return item;
}

function renderPatterns(patterns: readonly string[]): void {
  patternListEl.textContent = '';
  if (!patterns.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Ninguno';
    patternListEl.appendChild(empty);
    return;
  }
  const counts = countPatternMatches(buffer.entries, level, patterns);
  patterns.forEach((pattern, index) =>
    patternListEl.appendChild(patternRow(pattern, counts[index] ?? 0)),
  );
}

/** Repaint the panel and the toolbar toggle from current state. */
export function renderDrawer(): void {
  renderToggle();
  if (!drawerOpen()) return;
  const patterns = currentPatterns() ?? { warn: [], error: [] };
  setText(segWarnCountEl, String(patterns.warn.length));
  setText(segErrCountEl, String(patterns.error.length));
  renderLevel();
  // A rule just removed may be the one under the pointer.
  if (hovered && !patterns[level].includes(hovered)) hovered = null;
  renderPatterns(patterns[level]);
  if (!hovered) updateDraft();
}

function setLevel(next: SilenceLevel): void {
  if (next === level) return;
  level = next;
  saveLevel(next);
  hovered = null;
  renderDrawer();
}

/** A scope switch: the draft and its marks belonged to the previous log. */
export function resetSilenceScope(): void {
  hovered = null;
  draftInputEl.value = '';
  setDraftRegex(false);
  updateDraft();
  showPreview(null, 'draft');
}

export function setDrawer(open: boolean): void {
  drawerEl.hidden = !open;
  togglePanelBtn.classList.toggle('on', open);
  togglePanelBtn.setAttribute('aria-pressed', String(open));
  if (open) {
    renderDrawer();
    draftInputEl.focus();
  } else {
    hovered = null;
    showPreview(null, 'draft');
  }
}

/** A row's silence button: show the rule as a draft instead of saving it. */
function prefill(nextLevel: SilenceLevel, pattern: string): void {
  if (view.groupSources) return; // silencing is per service
  const { text, regex } = decodeSilencePattern(pattern);
  level = nextLevel;
  saveLevel(nextLevel);
  draftInputEl.value = text;
  setDraftRegex(regex);
  if (drawerOpen()) renderDrawer();
  else setDrawer(true);
  updateDraft();
  draftInputEl.focus();
}

installSilenceHooks({ prefill });

draftInputEl.addEventListener('input', scheduleDraft);
draftInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  submitDraft();
});
draftRegexBtn.addEventListener('click', () => {
  setDraftRegex(!draftIsRegex);
  updateDraft();
  draftInputEl.focus();
});
segWarnBtn.addEventListener('click', () => setLevel('warn'));
segErrBtn.addEventListener('click', () => setLevel('error'));

drawerCloseBtn.addEventListener('click', () => setDrawer(false));
togglePanelBtn.addEventListener('click', () => {
  // Silencing is per service. In a merged scope there is no single command to
  // act on: patterns would list empty (reading as "nothing is silenced") and a
  // typed pattern would be cleared from the input and dropped without a word.
  if (view.groupSources) {
    statusEl.textContent = 'Los silenciados son por servicio: elige uno';
    setTimeout(reportSelection, 2500);
    return;
  }
  setDrawer(!drawerOpen());
});

muteWarnEl.addEventListener('change', () => {
  if (view.currentGroupId && view.currentCommandId) {
    window.api.setCommandSilence(
      view.currentGroupId,
      view.currentCommandId,
      'warn',
      muteWarnEl.checked,
    );
  }
});
muteErrEl.addEventListener('change', () => {
  if (view.currentGroupId && view.currentCommandId) {
    window.api.setCommandSilence(
      view.currentGroupId,
      view.currentCommandId,
      'error',
      muteErrEl.checked,
    );
  }
});
