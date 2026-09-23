/**
 * The silenced drawer: the rules that swallow lines, and the lines they are
 * actually swallowing.
 *
 * It lives inside the logs window instead of a separate one so the two are
 * visible together — a rule you cannot inspect is a rule you stop trusting —
 * and unsilencing works straight from the feed.
 */
import { renderPatternList, wireAddPattern } from '../silence-ui.js';
import { fmtTime, mutedKey } from './format.js';
import { stripAnsi } from './ansi.js';
import { reportSelection } from './status.js';
import {
  drawerCloseBtn,
  drawerEl,
  drawerTargetEl,
  errAddBtn,
  errFeedEl,
  errInputEl,
  errListEl,
  muteErrEl,
  muteWarnEl,
  setText,
  statusEl,
  togglePanelBtn,
  warnAddBtn,
  warnFeedEl,
  warnInputEl,
  warnListEl,
} from './elements.js';
import { view } from './view.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { LogsTarget, SilenceLevel } from '../../src/ipc-contract.js';

/** Distinct swallowed lines kept per level before the oldest is dropped. */
const MUTED_FEED_LIMIT = 60;

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
}

function drawerOpen(): boolean {
  return !drawerEl.hidden;
}

/** Repaint the drawer's pattern lists and target label from current state. */
export function renderDrawer(): void {
  if (!drawerOpen()) return;
  const target = view.currentTarget;
  const patterns =
    target && target.kind === 'command' && target.target
      ? target.target.silencedPatterns || { warn: [], error: [] }
      : { warn: [], error: [] };
  setText(
    drawerTargetEl,
    view.displayName
      ? view.groupName
        ? `${view.groupName} · ${view.displayName}`
        : view.displayName
      : '',
  );
  const groupId = view.currentGroupId;
  const commandId = view.currentCommandId;
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

/** Wipe both feeds — called on every scope switch, see pushMutedLine. */
export function clearMutedFeeds(): void {
  warnFeedEl.textContent = '';
  errFeedEl.textContent = '';
  renderMutedCounts();
}

/**
 * Mirror a swallowed line into the drawer feed. Seeing WHAT a pattern eats is
 * the point — a rule you cannot inspect is a rule you stop trusting.
 */
export function pushMutedLine(entry: LogEntry): void {
  const level = entry.originalLevel;
  if (level !== 'warn' && level !== 'error') return;
  // Silencing is per-service, and unsilenceLine acts on the CURRENT selection.
  // A merged scope mixes many services, so a row here would remove a pattern
  // from whichever command happened to be selected — the wrong one.
  if (view.groupSources) return;
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
    feed.appendChild(buildMutedRow(entry, level, key));
    while (feed.childElementCount > MUTED_FEED_LIMIT && feed.firstChild)
      feed.removeChild(feed.firstChild);
  }
  renderMutedCounts();
}

function buildMutedRow(
  entry: LogEntry,
  level: SilenceLevel,
  key: string,
): HTMLElement {
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
  return row;
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
  if (!level || !view.currentGroupId || !view.currentCommandId) return;
  const cleaned = stripAnsi(entry.line).trim();
  const built = cleaned ? window.api.buildSilencePattern(cleaned) : cleaned;
  if (built && built !== cleaned)
    await window.api.removeSilencePattern(
      view.currentGroupId,
      view.currentCommandId,
      level,
      built,
    );
  await window.api.removeSilencePattern(
    view.currentGroupId,
    view.currentCommandId,
    level,
    cleaned,
  );
}

export function setDrawer(open: boolean): void {
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
      if (!view.currentGroupId || !view.currentCommandId) return;
      void window.api.addSilencePattern(
        view.currentGroupId,
        view.currentCommandId,
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
