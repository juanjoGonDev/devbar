/**
 * One line of a log view, as a DOM row: the same row in the logs window and
 * in the workflow terminal.
 *
 * Pure construction: it neither appends nor trims, so the pane can render any
 * slice of the buffer, repeatedly, without the side effects that used to be
 * tangled in here. What a row reads — the filters, the find query, the
 * selection, the stack blocks — comes from its view's context, and what it
 * does to the view (fold, unfold) goes back through `repaint`.
 *
 * The two ways OUT of a row — a source tag that opens another scope, a
 * timestamp that drops every filter and centres this line — are handed in
 * rather than imported: the scope switcher sits above the pane.
 */
import { ansiToHtml, stripAnsi } from '../logs/ansi.js';
import { levelOf } from '../logs/filters.js';
import { fmtTime, relativeTime, sourceColor } from '../logs/format.js';
import { markMatches } from '../logs/silence-marks.js';
import { hitRanges, type FindCursor } from '../logs/find-model.js';
import { BADGE_LABEL, badgeOf } from '../logs/line-level.js';
import {
  compactJson,
  isJsonOpen,
  jsonOf,
  jsonTokens,
  toggleJson,
  type JsonLine,
} from '../logs/json-line.js';
import { icon } from '../icon.js';
import { isFolded, toggleStack, type StackBlock } from '../logs/stack-fold.js';
import { PIPELINE_LOG_GROUP_ID } from '../../src/pipeline-labels.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SourcedLogEntry } from '../../src/ipc-contract.js';
import type { LogViewCtx } from './context.js';

/** How much of an object the one-line rendering shows before «…». */
const JSON_INLINE_CHARS = 160;

/** Coloured runs of JSON text, appended to `parent`. */
function appendJsonText(parent: HTMLElement, text: string): void {
  for (const token of jsonTokens(text)) {
    if (token.kind === 'punct') {
      parent.append(token.text);
      continue;
    }
    const run = cell(`j-${token.kind}`);
    run.textContent = token.text;
    parent.appendChild(run);
  }
}

function fillJson(body: HTMLElement, json: JsonLine): void {
  if (json.prefix) body.append(json.prefix);
  appendJsonText(body, compactJson(json.value, JSON_INLINE_CHARS).text);
}

/** «▸ JSON», and — once opened — the object pretty-printed under the line. */
function appendJsonToggle(
  msg: HTMLElement,
  entry: LogEntry,
  json: JsonLine,
  repaint: () => void,
): void {
  const open = isJsonOpen(entry);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'json-toggle';
  btn.append(icon(open ? 'chevron-down' : 'chevron-right'), 'JSON');
  btn.setAttribute('aria-expanded', String(open));
  btn.title = open ? 'Plegar el JSON' : 'Ver el JSON completo';
  btn.addEventListener('click', (event) => {
    event.stopPropagation(); // opening is not a row click
    toggleJson(entry);
    repaint();
  });
  msg.appendChild(btn);
  if (!open) return;
  const pre = document.createElement('pre');
  pre.className = 'json-pretty';
  appendJsonText(pre, JSON.stringify(json.value, null, 2));
  msg.appendChild(pre);
}

function cell(className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  return span;
}

/** The fold's own button: opens or closes the block, without selecting. */
function foldToggle(
  block: StackBlock,
  label: string,
  glyph: 'chevron-right' | 'chevron-down',
  repaint: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fold-toggle';
  btn.setAttribute('aria-expanded', String(glyph === 'chevron-down'));
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(icon(glyph));
  btn.addEventListener('click', (event) => {
    event.stopPropagation(); // a fold is not a row click
    toggleStack(block);
    repaint();
  });
  return btn;
}

/** «+N líneas de stack», then the first frame, muted. */
function foldSummary(
  block: StackBlock,
  first: LogEntry,
  repaint: () => void,
): HTMLElement {
  const msg = cell('msg');
  const btn = foldToggle(block, 'Mostrar el stack', 'chevron-right', repaint);
  const text = `+${block.members.length} líneas de stack`;
  btn.append(` ${text}`);
  btn.removeAttribute('title');
  btn.setAttribute('aria-label', text);
  const frame = cell('fold-first');
  frame.textContent = stripAnsi(first.line).trim();
  msg.append(btn, frame);
  return msg;
}

/** A row's clock, absolute or relative to now. */
export function stampText(ts: number, relative: boolean): string {
  return relative ? relativeTime(ts, Date.now()) : fmtTime(ts);
}

/** Drop every filter and land on this row, in sequence with its neighbours. */
type ShowInContext = (row: HTMLElement) => void;

export type BuildRow = (
  entry: LogEntry,
  entryIndex: number,
  showInContext: ShowInContext,
) => HTMLElement;

/** What a row reads from its view. */
export type RowCtx = Pick<
  LogViewCtx,
  'state' | 'buffer' | 'stacks' | 'nav' | 'prefs'
>;

/**
 * The row builder of one view. `repaint` rebuilds the drawn rows in place:
 * a row that folds or unfolds itself changes how the rows around it look.
 */
export function createRowBuilder(ctx: RowCtx, repaint: () => void): BuildRow {
  const { state: view, buffer, stacks, nav } = ctx;
  return function buildRow(entry, entryIndex, showInContext) {
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

    // A stack is only folded while «Solo coincidencias» hides nothing: with it
    // on, a frame that matches is drawn as itself, which is what opening its
    // block would show anyway. A plain search leaves blocks folded; landing on
    // a hit inside one opens it (see `find.ts`).
    const block = view.filterRe ? undefined : stacks.stackOf(entry);
    const foldable = block !== undefined && block.members.length > 1;
    const folded = block !== undefined && isFolded(block);
    if (block) {
      div.classList.add('stack');
      const headLevel = block.head.originalLevel ?? block.head.level;
      if (headLevel) div.classList.add(`under-${headLevel}`);
    }
    if (folded && block.members[0] !== entry) {
      // Hidden but present, so the window keeps one row per visible line.
      div.classList.add('folded');
      return div;
    }
    if (folded) {
      div.classList.add('stack-fold');
      div.append(cell('ts'), cell('lv'), foldSummary(block, entry, repaint));
      if (buffer.selected.has(entryIndex)) div.classList.add('selected');
      return div;
    }

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = stampText(entry.ts, ctx.prefs.relativeTime);
    // Plain `title`: installTooltips() takes it over and draws the styled bubble.
    ts.title = 'Ver en contexto · quita los filtros y centra esta línea';
    ts.addEventListener('click', (event) => {
      event.stopPropagation(); // don't disturb the line-selection handler
      showInContext(div);
    });
    div.appendChild(ts);
    if (foldable && block.members[0] === entry) {
      div.appendChild(
        foldToggle(block, 'Plegar stack', 'chevron-down', repaint),
      );
    } else if (block && badge !== 'err' && badge !== 'wrn') {
      // A frame says nothing a badge could add: the block reads as one unit
      // under the bar of the line it hangs from.
      div.appendChild(cell('lv'));
    } else {
      const lv = document.createElement('span');
      lv.className = `lv ${badge}`;
      lv.textContent = BADGE_LABEL[badge];
      div.appendChild(lv);
    }
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
          void nav?.openScope({ kind: 'group', groupId: source.groupId }, [
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
        void nav?.jumpToLine(srcId, entry.ts);
      });
      msg.appendChild(src);
    }

    const body = document.createElement('span');
    body.className = 'body';
    const json = jsonOf(entry);
    if (json) fillJson(body, json);
    else body.innerHTML = ansiToHtml(entry.line);
    if (view.findRe)
      markFindHits(div, body, entryIndex, view.findRe, view.findCurrent);
    if (previewed && view.silencePreview)
      markMatches(body, view.silencePreview.matcher);
    msg.appendChild(body);
    if (json) appendJsonToggle(msg, entry, json, repaint);

    if (buffer.selected.has(entryIndex)) div.classList.add('selected');
    return div;
  };
}

/**
 * Mark where the find query bites, and light up the hit the widget is on.
 * The ranges come from the same function that counted them, so «3 de 27»
 * and the third mark agree.
 */
function markFindHits(
  row: HTMLElement,
  body: HTMLElement,
  entryIndex: number,
  re: RegExp,
  current: FindCursor | null,
): void {
  markMatches(
    body,
    { ranges: (text) => hitRanges(text, re) },
    'find-hit',
    true,
  );
  if (current?.entry !== entryIndex) return;
  row.classList.add('find-current');
  for (const mark of Array.from(
    body.querySelectorAll(`mark.find-hit[data-hit="${current.hit}"]`),
  ))
    mark.classList.add('current');
}
