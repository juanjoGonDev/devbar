/**
 * One line of the log, as a DOM row.
 *
 * Pure construction: it neither appends nor trims, so the window layer can
 * render any slice of the buffer, repeatedly, without the side effects that
 * used to be tangled in here.
 *
 * The two ways OUT of a row — a source tag that opens another scope, a
 * timestamp that drops every filter and centres this line — are handed in
 * rather than imported: the scope switcher sits above this module and
 * importing it back would close a cycle.
 */
import { ansiToHtml, stripAnsi } from './ansi.js';
import { levelOf } from './filters.js';
import { fmtTime, sourceColor } from './format.js';
import { buffer } from './buffer.js';
import { markMatches } from './silence-marks.js';
import { BADGE_LABEL, badgeOf } from './line-level.js';
import { icon } from '../icon.js';
import { nav, silenceHooks, view } from './view.js';
import { PIPELINE_LOG_GROUP_ID } from '../../src/pipeline-labels.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SilenceLevel, SourcedLogEntry } from '../../src/ipc-contract.js';

/** Enough to see where the search bites without marking a 20 KB line solid. */
const MAX_SEARCH_HITS = 50;

/** Drop every filter and land on this row, in sequence with its neighbours. */
export type ShowInContext = (row: HTMLElement) => void;

/**
 * Build one row. Pure construction: it neither appends nor trims, so the
 * window layer can render any slice of the buffer, repeatedly, without the
 * side effects that used to be tangled in here.
 */
export function buildRow(
  entry: LogEntry,
  entryIndex: number,
  showInContext: ShowInContext,
): HTMLElement {
  const div = document.createElement('div');
  const badge = badgeOf(entry);
  const classes = ['line', entry.stream];
  if (entry.level) classes.push(entry.level);
  if (badge === 'dbg') classes.push('dbg');
  if (entry.silenced) classes.push('silenced');
  const previewed = !!view.silencePreview?.swallows(entry);
  if (previewed) classes.push('would-silence');
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
  const lv = document.createElement('span');
  lv.className = `lv ${badge}`;
  lv.textContent = BADGE_LABEL[badge];
  div.appendChild(lv);
  // The third column holds everything else — source tags and the text — so a
  // merged row's tags flow inline with its message instead of taking columns.
  const msg = document.createElement('span');
  msg.className = 'msg';
  div.appendChild(msg);
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
  const source =
    view.groupSources && srcId ? view.groupSources.get(srcId) : undefined;
  if (source) {
    div.dataset.src = source.name;
    div.dataset.group = source.groupName;
    // The group tag is redundant inside a single real group's own view,
    // where every source shares that same group — but not in the pipeline's
    // own merged view, whose sources are whichever real groups' scripts
    // took part, exactly like "Todo".
    if (
      view.mergedGroupId === null ||
      view.mergedGroupId === PIPELINE_LOG_GROUP_ID
    ) {
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
        void nav.openScope({ kind: 'group', groupId: source.groupId }, [
          ...view.levelFilter,
        ]);
      });
      msg.appendChild(grp);
    }
    const src = document.createElement('button');
    src.type = 'button';
    src.className = 'src';
    src.textContent = `[${source.name}]`;
    src.title = `Ir a esta línea en ${source.name}`;
    src.style.color = sourceColor(source.name);
    src.addEventListener('click', (event) => {
      event.stopPropagation();
      void nav.jumpToLine(srcId, entry.ts);
    });
    msg.appendChild(src);
  }

  const body = document.createElement('span');
  body.className = 'body';
  body.innerHTML = ansiToHtml(entry.line);
  if (view.filterRe)
    markMatches(body, searchMatcher(view.filterRe), 'search-hit');
  if (previewed && view.silencePreview)
    markMatches(body, view.silencePreview.matcher);
  msg.appendChild(body);

  if (
    (entry.originalLevel === 'warn' || entry.originalLevel === 'error') &&
    view.currentGroupId &&
    view.currentCommandId
  ) {
    const groupId = view.currentGroupId;
    const commandId = view.currentCommandId;
    const btn = document.createElement('button');
    btn.className = 'silence-btn';
    btn.append(icon(entry.silenced ? 'bell' : 'bell-off'));
    btn.title = entry.silenced
      ? 'Quitar silencio (esta línea)'
      : 'Silenciar líneas como esta…';
    btn.setAttribute('aria-label', btn.title);
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
        // Not saved yet: the popover opens with it as the draft, so the preview
        // shows what else it would swallow before anything is silenced. The
        // popover acts on the command on screen, so a stale row does nothing.
        if (
          view.currentGroupId === groupId &&
          view.currentCommandId === commandId
        )
          silenceHooks.prefill(lvl, pattern || cleaned);
      }
    });
    msg.appendChild(btn);
  }

  if (buffer.selected.has(entryIndex)) div.classList.add('selected');
  return div;
}

/** Every non-empty run the search box's regex finds, for highlighting. */
interface Ranges {
  ranges(text: string): Array<[number, number]>;
}

// One compiled matcher per filter: rows are built hundreds at a time and the
// filter only changes on a keystroke.
let searchCache: { re: RegExp; matcher: Ranges } | null = null;

function searchMatcher(re: RegExp): Ranges {
  if (searchCache?.re === re) return searchCache.matcher;
  const global = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  const matcher: Ranges = {
    ranges(text) {
      const out: Array<[number, number]> = [];
      global.lastIndex = 0;
      while (out.length < MAX_SEARCH_HITS) {
        const match = global.exec(text);
        if (!match) break;
        if (match[0].length === 0) {
          global.lastIndex += 1;
          continue;
        }
        out.push([match.index, match.index + match[0].length]);
      }
      return out;
    },
  };
  searchCache = { re, matcher };
  return matcher;
}
