/**
 * The silenced popover: the rules that swallow lines, and a draft that shows
 * what it WOULD swallow before it is saved.
 *
 * It floats over the log, under its toolbar toggle, instead of living in a
 * separate window or a docked column: the rules and the lines they eat stay
 * visible together, and the log keeps its full width. The draft previews live
 * against the lines already held (a count in the field, the rows tinted and
 * the matched text marked in the log), and hovering a saved rule marks what
 * it is eating the same way. The matching itself is in `silence-preview.ts`,
 * pure; the marks are in `silence-marks.ts`; this module puts it on screen.
 */
import { icon } from '../icon.js';
import { reportSelection } from './status.js';
import {
  checkDraft,
  compilePattern,
  countPatternMatches,
  entryWouldSilence,
  previewPattern,
  type PatternMatcher,
} from './silence-preview.js';
import { buffer } from './buffer.js';
import { markMatches, unmarkMatches } from './silence-marks.js';
import {
  composerEl,
  draftCountEl,
  draftErrorEl,
  draftInputEl,
  draftRegexBtn,
  levelErrBtn,
  levelWarnBtn,
  linesEl,
  muteErrEl,
  muteWarnEl,
  patternListEl,
  popoverEl,
  setText,
  silencePreviewEl,
  silencePreviewTextEl,
  silenceToggleBtn,
  silenceToggleCountEl,
  statusEl,
  submitBtn,
} from './elements.js';
import { installSilenceHooks, view } from './view.js';
import { decodeSilencePattern } from '../../src/silence-pattern.js';
import type { LogsTarget, SilenceLevel } from '../../src/ipc-contract.js';

/** Typing settles for this long before the preview re-reads the buffer. */
const PREVIEW_DEBOUNCE_MS = 100;
const LEVEL_KEY = 'devbar.logs.silence-level';
const LEVELS: readonly SilenceLevel[] = ['warn', 'error'];

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

/** The level a new rule is saved at. Saved rules carry their own. */
let level: SilenceLevel = loadLevel();
let draftIsRegex = false;
let draftTimer: ReturnType<typeof setTimeout> | null = null;

interface Rule {
  level: SilenceLevel;
  pattern: string;
}

/** A saved rule under the pointer wins over the draft until it is left. */
let hovered: Rule | null = null;

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

function popoverOpen(): boolean {
  return !popoverEl.hidden;
}

function currentPatterns(): Record<SilenceLevel, string[]> | null {
  const target = view.currentTarget;
  if (!target || target.kind !== 'command' || !target.target) return null;
  const patterns = target.target.silencedPatterns;
  return { warn: patterns?.warn ?? [], error: patterns?.error ?? [] };
}

/** Every rule of the command on screen, both levels; nothing without one. */
function renderToggle(): void {
  const patterns = currentPatterns();
  setText(
    silenceToggleCountEl,
    patterns ? String(patterns.warn.length + patterns.error.length) : '',
  );
}

// ─────────────────────────── Preview ───────────────────────────

type PreviewSource = 'draft' | 'hover';

/**
 * Mark the rows `matcher` would swallow at `previewLevel` — the drawn ones
 * now, and through `view.silencePreview` any row built later — and say how
 * many in the footer. `null` takes every mark away.
 */
function showPreview(
  matcher: PatternMatcher | null,
  previewLevel: SilenceLevel,
  source: PreviewSource,
): void {
  view.silencePreview = matcher
    ? {
        swallows: (entry) => entryWouldSilence(entry, previewLevel, matcher),
        matcher,
      }
    : null;
  for (const row of Array.from(
    linesEl.querySelectorAll<HTMLElement>('.line'),
  )) {
    const entry = buffer.entries[Number(row.dataset.eidx)];
    const swallowed = !!entry && !!view.silencePreview?.swallows(entry);
    row.classList.toggle('would-silence', swallowed);
    const body = row.querySelector<HTMLElement>('.body');
    if (!body) continue;
    unmarkMatches(body);
    if (swallowed && matcher) markMatches(body, matcher);
  }
  if (!matcher) {
    silencePreviewEl.hidden = true;
    return;
  }
  const { count } = previewPattern(buffer.entries, previewLevel, matcher);
  silencePreviewEl.hidden = false;
  setText(
    silencePreviewTextEl,
    source === 'draft'
      ? `${count} ${count === 1 ? 'se silenciaría' : 'se silenciarían'} con el patrón nuevo`
      : `${count} ${count === 1 ? 'coincide' : 'coinciden'} con este patrón`,
  );
}

function clearPreview(): void {
  showPreview(null, level, 'draft');
}

/** Re-read the draft: validity, its count, the button and the log's marks. */
function updateDraft(): void {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  const check = checkDraft(draftInputEl.value, draftIsRegex);
  const invalid = check.kind === 'invalid';
  composerEl.classList.toggle('invalid', invalid);
  draftErrorEl.hidden = !invalid;
  setText(draftErrorEl, invalid ? check.message : '');
  submitBtn.disabled = check.kind !== 'ok';
  if (check.kind !== 'ok') {
    draftCountEl.hidden = true;
    setText(submitBtn, 'Silenciar');
    if (!hovered) clearPreview();
    return;
  }
  const matcher = compilePattern(check.pattern);
  const result = previewPattern(buffer.entries, level, matcher);
  draftCountEl.hidden = false;
  setText(draftCountEl, `${result.count}${result.truncated ? '+' : ''}`);
  setText(submitBtn, result.count ? `Silenciar ${result.count}` : 'Silenciar');
  if (!hovered) showPreview(matcher, level, 'draft');
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

// ─────────────────────────── Popover ───────────────────────────

function renderLevel(): void {
  for (const [button, own] of [
    [levelWarnBtn, 'warn'],
    [levelErrBtn, 'error'],
  ] as const)
    button.setAttribute('aria-pressed', String(own === level));
}

function ruleRow(rule: Rule, count: number): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'rule';
  item.dataset.level = rule.level;
  const dot = document.createElement('span');
  dot.className = 'sil-dot';
  const code = document.createElement('code');
  const shown = decodeSilencePattern(rule.pattern).text;
  code.textContent = shown;
  code.title = shown;
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  cnt.textContent = String(count);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'x';
  remove.setAttribute('aria-label', 'Quitar regla');
  remove.title = 'Quitar regla';
  remove.append(icon('x'));
  remove.addEventListener('click', () => {
    if (!view.currentGroupId || !view.currentCommandId) return;
    void window.api.removeSilencePattern(
      view.currentGroupId,
      view.currentCommandId,
      rule.level,
      rule.pattern,
    );
  });
  item.addEventListener('mouseenter', () => {
    hovered = rule;
    showPreview(compilePattern(rule.pattern), rule.level, 'hover');
  });
  item.addEventListener('mouseleave', () => {
    if (hovered !== rule) return;
    hovered = null;
    updateDraft(); // back to the draft's marks, or to none
  });
  item.append(dot, code, cnt, remove);
  return item;
}

function ruleCounts(patterns: Record<SilenceLevel, string[]>): number[] {
  return LEVELS.flatMap((own) =>
    countPatternMatches(buffer.entries, own, patterns[own]),
  );
}

/** The patterns the rows on screen were built for. */
let renderedKey: string | null = null;

function renderRules(patterns: Record<SilenceLevel, string[]>): void {
  // State pushes repaint the popover constantly on a busy service. Rebuilding
  // the rows between press and release of × loses the click, so when the
  // rules are the same ones, only their counts are refreshed.
  const key = JSON.stringify(patterns);
  if (key === renderedKey) {
    const counts = ruleCounts(patterns);
    patternListEl
      .querySelectorAll<HTMLElement>('.rule .cnt')
      .forEach((cnt, index) => setText(cnt, String(counts[index] ?? 0)));
    return;
  }
  renderedKey = key;
  patternListEl.textContent = '';
  const rules: Rule[] = LEVELS.flatMap((own) =>
    patterns[own].map((pattern) => ({ level: own, pattern })),
  );
  if (!rules.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Sin reglas';
    patternListEl.appendChild(empty);
    return;
  }
  const counts = ruleCounts(patterns);
  rules.forEach((rule, index) =>
    patternListEl.appendChild(ruleRow(rule, counts[index] ?? 0)),
  );
}

/** Repaint the popover and the toolbar toggle from current state. */
export function renderSilencePopover(): void {
  renderToggle();
  if (!popoverOpen()) return;
  const patterns = currentPatterns() ?? { warn: [], error: [] };
  renderLevel();
  // A rule just removed may be the one under the pointer.
  if (hovered && !patterns[hovered.level].includes(hovered.pattern))
    hovered = null;
  renderRules(patterns);
  if (!hovered) updateDraft();
}

function setLevel(next: SilenceLevel): void {
  if (next === level) return;
  level = next;
  saveLevel(next);
  hovered = null;
  renderSilencePopover();
}

/** A scope switch: the draft and its marks belonged to the previous log. */
export function resetSilenceScope(): void {
  hovered = null;
  draftInputEl.value = '';
  setDraftRegex(false);
  updateDraft();
  clearPreview();
}

export function setSilencePopover(open: boolean): void {
  const wasOpen = popoverOpen();
  popoverEl.hidden = !open;
  silenceToggleBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    renderSilencePopover();
    draftInputEl.focus();
    return;
  }
  hovered = null;
  clearPreview();
  // Focus left inside a hidden popover is focus nobody can see.
  const active = document.activeElement;
  if (
    wasOpen &&
    (!active || active === document.body || popoverEl.contains(active))
  )
    silenceToggleBtn.focus();
}

/** A row's silence button: show the rule as a draft instead of saving it. */
function prefill(nextLevel: SilenceLevel, pattern: string): void {
  if (view.groupSources) return; // silencing is per service
  const { text, regex } = decodeSilencePattern(pattern);
  level = nextLevel;
  saveLevel(nextLevel);
  draftInputEl.value = text;
  setDraftRegex(regex);
  if (popoverOpen()) renderSilencePopover();
  else setSilencePopover(true);
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
submitBtn.addEventListener('click', submitDraft);
levelWarnBtn.addEventListener('click', () => setLevel('warn'));
levelErrBtn.addEventListener('click', () => setLevel('error'));

silenceToggleBtn.addEventListener('click', () => {
  // Silencing is per service. In a merged scope there is no single command to
  // act on: rules would list empty (reading as "nothing is silenced") and a
  // typed pattern would be cleared from the input and dropped without a word.
  if (view.groupSources) {
    statusEl.textContent = 'Los silenciados son por servicio: elige uno';
    setTimeout(reportSelection, 2500);
    return;
  }
  setSilencePopover(!popoverOpen());
});

// Escape closes the popover before anything else hears it: the log's own
// Escape (dropping the selection) is not what was meant while it is open.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape' || !popoverOpen()) return;
    event.stopPropagation();
    setSilencePopover(false);
  },
  true,
);

// A press anywhere else closes it — except the toggle, which toggles, and a
// row's silence action, which fills the draft and wants the popover open.
document.addEventListener('mousedown', (event) => {
  if (!popoverOpen()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (popoverEl.contains(target) || silenceToggleBtn.contains(target)) return;
  if (target.closest('.row-actions')) return;
  setSilencePopover(false);
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
