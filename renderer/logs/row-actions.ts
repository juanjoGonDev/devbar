/**
 * The small toolbar floating over the row under the pointer: «Copiar línea»,
 * «Silenciar» and «Filtrar por esto».
 *
 * There is ONE toolbar, moved into whichever row is hovered. A toolbar per
 * row would triple the nodes every repaint builds — the window draws hundreds
 * of rows at a time and redraws them on every scroll — for buttons only one
 * row can show at once. The row it sits on names the entry through
 * `data-eidx`, so the actions read the line from the buffer, never from the
 * drawn text: a JSON line copies as printed, not as coloured.
 */
import { closestElement } from '../dom.js';
import { icon, iconButton } from '../icon.js';
import { stripAnsi } from './ansi.js';
import { buffer } from './buffer.js';
import { filterEl, linesEl, mainEl, statusEl } from './elements.js';
import { reportSelection } from './status.js';
import { silenceHooks, view } from './view.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel } from '../../src/ipc-contract.js';

const SILENCE_LABEL = 'Silenciar líneas como esta…';
const UNSILENCE_LABEL = 'Quitar silencio (esta línea)';

const toolbar = document.createElement('div');
toolbar.className = 'row-actions';
const copyBtn = iconButton('copy', 'Copiar línea', 'ra-btn');
const silenceBtn = iconButton('bell-off', SILENCE_LABEL, 'ra-btn ra-silence');
const filterBtn = iconButton('funnel', 'Filtrar por esto', 'ra-btn');
toolbar.append(copyBtn, silenceBtn, filterBtn);

/** The entry the toolbar is sitting on, if it still exists. */
function hovered(): { row: HTMLElement; entry: LogEntry } | null {
  const row = toolbar.parentElement;
  if (!row) return null;
  const entry = buffer.entries[Number(row.dataset.eidx)];
  return entry ? { row, entry } : null;
}

/** The silence button applies to warn/error lines of a single command. */
function canSilence(entry: LogEntry): boolean {
  const level = entry.originalLevel;
  return (
    (level === 'warn' || level === 'error') &&
    !!view.currentGroupId &&
    !!view.currentCommandId
  );
}

function showOn(row: HTMLElement): void {
  if (toolbar.parentElement === row) return;
  const entry = buffer.entries[Number(row.dataset.eidx)];
  if (!entry) return;
  silenceBtn.hidden = !canSilence(entry);
  const label = entry.silenced ? UNSILENCE_LABEL : SILENCE_LABEL;
  silenceBtn.title = label;
  silenceBtn.setAttribute('aria-label', label);
  silenceBtn.replaceChildren(icon(entry.silenced ? 'bell' : 'bell-off'));
  // Unwrapped, a row is as wide as the longest line: pin the toolbar to the
  // right edge of what is on screen, not to the far end of the row.
  const offscreen = linesEl.classList.contains('nowrap')
    ? row.offsetWidth - mainEl.scrollLeft - mainEl.clientWidth
    : 0;
  toolbar.style.right = offscreen > 0 ? `${offscreen + 14}px` : '';
  row.appendChild(toolbar);
}

/**
 * What «Filtrar por esto» searches for when nothing is selected: the longest
 * word of the line that has a letter in it — a route, a class, an error name
 * — once leading `[tags]` and the brackets around a token are dropped. Ids
 * and counters carry no letters, so they never win. Empty when nothing fits.
 */
export function filterTokenFor(line: string): string {
  const text = stripAnsi(line).replace(/^\s*(?:\[[^\]]*\]\s*)+/, '');
  let best = '';
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[([{"'<]+|[)\]}"'>,.;:!?]+$/g, '');
    if (token.length < 3 || !/[a-z]/i.test(token)) continue;
    if (token.length > best.length) best = token;
  }
  return best;
}

/** Text the reader selected inside `row`, if any — one line of it. */
function selectedIn(row: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return '';
  if (!row.contains(selection.anchorNode)) return '';
  const text = selection.toString().trim();
  return text.includes('\n') ? '' : text;
}

function act(button: HTMLButtonElement, run: () => void): void {
  button.addEventListener('click', (event) => {
    event.stopPropagation(); // an action is not a row click
    run();
  });
}

act(copyBtn, () => {
  const target = hovered();
  if (!target) return;
  void navigator.clipboard
    .writeText(stripAnsi(target.entry.line))
    .then(() => {
      statusEl.replaceChildren('Copiado ', icon('check'));
      setTimeout(reportSelection, 1500);
    })
    .catch(() => {
      statusEl.textContent = 'Error al copiar';
    });
});

act(filterBtn, () => {
  const target = hovered();
  if (!target) return;
  const query = selectedIn(target.row) || filterTokenFor(target.entry.line);
  if (!query) return;
  window.getSelection()?.removeAllRanges();
  filterEl.value = query;
  filterEl.dispatchEvent(new Event('input')); // the pane re-filters on input
});

act(silenceBtn, () => {
  const target = hovered();
  const groupId = view.currentGroupId;
  const commandId = view.currentCommandId;
  if (!target || !groupId || !commandId || !canSilence(target.entry)) return;
  const { entry } = target;
  const level = entry.originalLevel as SilenceLevel;
  const cleaned = stripAnsi(entry.line).trim();
  // Build a regex pattern when possible so it matches across timestamp changes
  const pattern = cleaned ? window.api.buildSilencePattern(cleaned) : cleaned;
  if (!entry.silenced) {
    // Not saved yet: the popover opens with it as the draft, so the preview
    // shows what else it would swallow before anything is silenced.
    silenceHooks.prefill(level, pattern || cleaned);
    return;
  }
  // Remove the built pattern first, then the literal it may have been saved
  // as; removeSilencePattern is a no-op when the pattern is not found.
  void (async () => {
    if (pattern && pattern !== cleaned)
      await window.api.removeSilencePattern(groupId, commandId, level, pattern);
    await window.api.removeSilencePattern(groupId, commandId, level, cleaned);
  })();
});

linesEl.addEventListener('mouseover', (event) => {
  const row = closestElement(event.target, '.line');
  if (row && linesEl.contains(row)) showOn(row);
});

linesEl.addEventListener('mouseleave', () => toolbar.remove());
