/**
 * The controls the sidebar tree is made of: a service row, a group header, the
 * root "Todo" row, and the warn/error counters that double as the way in.
 *
 * Building and PAINTING are deliberately separate. The tree is rebuilt only
 * when its shape changes, so everything that can change without the shape
 * changing — counters, dots, clocks, names, icons — has to live in a paint
 * function, or an open window would keep showing what the config said an hour
 * ago.
 */
import { canRun, groupDotClass, isRunning } from '../log-status.js';
import { PIPELINE_LOG_GROUP_ID } from '../../src/pipeline-labels.js';
import { toggleRunById } from './header.js';
import { openScope, selectLog } from './scope.js';
import { setText } from './elements.js';
import { layoutGroupItems } from './sidebar-fold.js';
import { isActive, runningOfTotal } from './sidebar-order.js';
import { view } from './view.js';
import { customIconsVersion, icon, userIcon, type IconName } from '../icon.js';
import type {
  LogListGroup,
  LogListItem,
  SilenceLevel,
} from '../../src/ipc-contract.js';

/**
 * Paints a user icon into `host` only when it changed — this runs on every
 * one-second repaint, and the name/icon of a row arrive through it (see the
 * module doc), so it must be cheap and idempotent like `setText`.
 */
function paintIcon(
  host: HTMLElement,
  value: string | null,
  fallback: IconName,
  color: string | null,
): void {
  // The library version is part of the key: an `img:<id>` whose image was
  // just uploaded or deleted must repaint although its value did not change.
  const key = `${value ?? ''}|${fallback}|${color ?? ''}|${customIconsVersion()}`;
  if (host.dataset.icon === key) return;
  host.dataset.icon = key;
  host.replaceChildren(userIcon(value, fallback, color));
}

function groupOpenKey(groupId: string): string {
  return `devbar.logs.group.${groupId}`;
}

/** The pipeline bucket is a cross-cutting view, and says so with its own mark. */
function groupFallbackIcon(group: LogListGroup): IconName {
  return group.groupId === PIPELINE_LOG_GROUP_ID ? 'workflow' : 'folder';
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
  // The pill's colour says which level it is; the tooltip spells it out.
  btn.textContent = String(count);
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  });
  return btn;
}

/**
 * The warn/error counters, and nothing when both are zero: a quiet service
 * needs no badge to say so.
 */
function renderBadges(host: HTMLElement, item: LogListItem): void {
  // Guard the rebuild. This runs on every sidebar repaint, including the
  // one-second tick, and the counters are BUTTONS: replacing one between
  // mousedown and mouseup means the browser never fires the click, so pressing
  // a counter silently does nothing. It also drops any pending tooltip anchor.
  // The name is in the signature because these buttons spell it out.
  const signature = [item.name, item.warnCount, item.errorCount].join('|');
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
}

function buildSideItem(item: LogListItem): HTMLElement {
  // A container, not a button. The row holds the run control and the counter
  // buttons, and HTML forbids interactive descendants inside a <button>: the
  // DOM API lets us build the tree anyway, but assistive technology is free to
  // flatten it or announce the wrong control. The whole row is still one hit
  // target — `.s-open` covers it underneath, so the tree is honest and the
  // behaviour is unchanged.
  const row = document.createElement('div');
  row.className = 'side-item';
  row.dataset.id = item.id;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 's-open';
  open.addEventListener('click', () => void selectLog(item.id));
  row.appendChild(open);

  // One 30px line: the state dot, the name, and counters only when there is
  // something to count. How long it has been running is the toolbar's to say.
  const head = document.createElement('span');
  head.className = 's-head';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 's-name';
  head.append(dot, name);
  row.appendChild(head);

  const badges = document.createElement('span');
  badges.className = 's-badges';
  row.appendChild(badges);

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 's-run';
  run.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Rows are repainted in place, so resolve the current state on click
    // instead of the snapshot this row was built from.
    toggleRunById(item.id);
  });
  row.appendChild(run);
  return row;
}

export function paintSideItem(row: HTMLElement, item: LogListItem): void {
  // Green while running, grey otherwise: warnings and errors have their own
  // counters now, so the dot only answers "is it up?".
  const active = isActive(item);
  const dot = row.querySelector<HTMLElement>('.dot');
  if (dot)
    dot.className = active
      ? `dot ${item.status === 'running' ? 'running' : item.status}`
      : 'dot';
  row.classList.toggle('stopped', !active);
  // The name is painted, never built: a rename in the config reaches an open
  // window through this path, and only this one — the tree is rebuilt solely
  // when a service appears or goes away.
  const name = row.querySelector<HTMLElement>('.s-name');
  if (name) {
    name.textContent = item.name;
    name.title = item.name;
  }
  // The row is a container now, so the name has to reach the control that
  // opens it or the button announces itself as unlabelled.
  const open = row.querySelector<HTMLButtonElement>('.s-open');
  if (open) open.setAttribute('aria-label', `Ver los logs de ${item.name}`);
  const badges = row.querySelector<HTMLElement>('.s-badges');
  if (badges) renderBadges(badges, item);
  const run = row.querySelector<HTMLButtonElement>('.s-run');
  if (run) {
    const runnable = canRun(item);
    run.style.display = runnable ? '' : 'none';
    const running = isRunning(item);
    const glyph = running ? 'square' : 'play';
    // Repainted every second: only swap the glyph when the state flipped.
    if (run.dataset.icon !== glyph) {
      run.dataset.icon = glyph;
      run.replaceChildren(icon(glyph));
    }
    run.title = running ? 'Parar' : 'Arrancar';
    run.setAttribute('aria-label', run.title);
    run.classList.toggle('on', running);
  }
  row.classList.toggle('active', item.id === view.processId);
}

/**
 * The root of the scope hierarchy, pinned above the groups: everything, from
 * everywhere. Without it the sidebar could walk you down (group → service) but
 * never back up to the whole picture.
 */
export function buildAllRow(): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'side-all';
  row.classList.toggle('active', view.mergedIsAll);
  const ico = document.createElement('span');
  ico.className = 'a-ico';
  ico.append(icon('scroll-text'));
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

/** The two-line name/badges column every group header shares. */
function buildGroupMain(): HTMLElement {
  const gMain = document.createElement('span');
  gMain.className = 'g-main';
  const gName = document.createElement('span');
  gName.className = 'g-name';
  const gBadges = document.createElement('span');
  gBadges.className = 'g-badges';
  gMain.append(gName, gBadges);
  return gMain;
}

/**
 * The pipeline aggregator's own row, pinned right after "Todo" and above the
 * real groups: it is a cross-cutting view like "Todo", not one group among
 * the others. Unlike a real group it renders NO per-run children — with a
 * single run the bucket and its one child showed the exact same thing, which
 * read as duplication. The whole row opens the merged pipeline view
 * directly (the same view the `g-all` control opens for a real group); every
 * run's lines stay reachable there, each already prefixed with its own run
 * label, so nothing is lost by not expanding.
 */
export function buildPipelineRow(group: LogListGroup): HTMLElement {
  const details = document.createElement('details');
  details.className = 'side-group';
  details.dataset.groupId = group.groupId;
  const summary = document.createElement('summary');
  const gIco = document.createElement('span');
  gIco.className = 'g-ico';
  const gDot = document.createElement('span');
  gDot.className = 'g-dot';
  summary.append(gIco, buildGroupMain(), gDot);
  // No chevron, no `side-items` box to expand into: `preventDefault` stops
  // the native <details> toggle so the whole row acts as one open button,
  // exactly like the "Todo" row above it.
  summary.addEventListener('click', (event) => {
    event.preventDefault();
    void openScope({ kind: 'group', groupId: group.groupId });
  });
  details.appendChild(summary);
  paintGroupSummary(details, group);
  return details;
}

export function buildGroupRow(group: LogListGroup): HTMLElement {
  const details = document.createElement('details');
  details.className = 'side-group';
  details.dataset.groupId = group.groupId;
  details.open = localStorage.getItem(groupOpenKey(group.groupId)) !== 'closed';
  details.addEventListener('toggle', () =>
    localStorage.setItem(
      groupOpenKey(group.groupId),
      details.open ? 'open' : 'closed',
    ),
  );
  const summary = document.createElement('summary');
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.append(icon('chevron-right'));
  // Name, its group-wide warn/error totals when there are any, and how many
  // of its services are running out of how many there are.
  const gCount = document.createElement('span');
  gCount.className = 'g-count';
  // Opens the merged view for the whole group. It lives inside <summary>, so
  // it must swallow the click — otherwise <details> would just fold shut.
  const gAll = document.createElement('button');
  gAll.type = 'button';
  gAll.className = 'g-all';
  gAll.append(icon('scroll-text')); // same mark as every other "open logs" control
  gAll.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openScope({ kind: 'group', groupId: group.groupId });
  });
  summary.append(chevron, buildGroupMain(), gCount, gAll);
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
  layoutGroupItems(details, group);
  paintGroupSummary(details, group);
  return details;
}
/**
 * Refresh the root row's totals: the warn/error counts of everything, from
 * everywhere. Those totals are buttons — they open the merged view already
 * pinned to that level.
 */
export function paintAllRow(row: HTMLElement): void {
  const badges = row.querySelector<HTMLElement>('.a-badges');
  if (!badges) return;
  const items = view.sideData.flatMap((group) => group.items);
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

/**
 * Refresh a group header: its name and icon, the rollup dot, and the
 * warn/error totals of everything inside it. Those totals are buttons — they
 * open the group's merged view already pinned to that level.
 */
export function paintGroupSummary(
  details: HTMLElement,
  group: LogListGroup,
): void {
  // Painted, never built, for the same reason the service rows are: a group
  // renamed in the config keeps the same id, so the tree is not rebuilt and
  // this is the only path the new name can arrive through.
  const ico = details.querySelector<HTMLElement>('.g-ico');
  if (ico)
    paintIcon(
      ico,
      group.groupIcon,
      groupFallbackIcon(group),
      group.groupIconColor,
    );
  const gName = details.querySelector<HTMLElement>('.g-name');
  if (gName) setText(gName, group.groupName);
  // Real groups open their merged view from the `g-all` control; the pipeline
  // bucket has no chevron and opens from the whole row, so the label sits on
  // the summary itself.
  const opener =
    details.querySelector<HTMLElement>('.g-all') ??
    (details.dataset.groupId === PIPELINE_LOG_GROUP_ID
      ? details.querySelector<HTMLElement>('summary')
      : null);
  if (opener) {
    opener.title = `Ver todos los logs de ${group.groupName} juntos`;
    if (opener.classList.contains('g-all'))
      opener.setAttribute('aria-label', opener.title);
  }
  const count = details.querySelector<HTMLElement>('.g-count');
  if (count) {
    setText(count, runningOfTotal(group.items));
    count.title = 'En marcha / total';
  }
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
  // The name is in there because the buttons spell it out in their tooltips.
  const signature = `${warns}/${errors}/${group.groupName}`;
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
