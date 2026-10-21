import { icon, iconButton, userIcon, type IconName } from '../icon.js';
import type { MenuEntry } from './remote-device-menu.js';
import type { Schedule } from '../../src/domain-types.js';
import { summarizeSchedule } from './schedule-editor.js';

/** One row of a group's commands, actions or pre-scripts. */
export interface SubRowSpec {
  id: string;
  name: string;
  commandLine: string;
  /** The item's own icon, or null to leave the slot empty. */
  icon: string | null;
  iconColor?: string | null;
  fallbackIcon: IconName;
  /** Compact tags at the trailing edge (Auto, the schedule). */
  tags: HTMLElement[];
  running: boolean;
  /** Extra buttons placed before «Editar», e.g. the auto-start toggle. */
  extraActions: HTMLElement[];
  edit(): void;
  /** The «⋯» menu's entries for this row. */
  menuEntries(): MenuEntry[];
  openMenu(trigger: HTMLButtonElement, entries: MenuEntry[]): void;
}

/**
 * A list row: drag handle, the item's icon, name and command line, then its
 * tags. Its actions show on hover or keyboard focus only; a click anywhere
 * else on the row opens the editor.
 */
export function buildSubRow(spec: SubRowSpec, className: string): HTMLElement {
  const row = document.createElement('div');
  row.className = `${className} drag-row`;
  row.dataset.id = spec.id;
  row.classList.toggle('is-running', spec.running);

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.draggable = true;
  handle.title = 'Arrastra para reordenar';
  handle.append(icon('grip-vertical'));
  row.append(handle);

  const iconSlot = document.createElement('span');
  iconSlot.className = 'sub-icon-slot';
  if (spec.icon) {
    const iconEl = document.createElement('span');
    iconEl.className = 'sub-icon';
    iconEl.append(userIcon(spec.icon, spec.fallbackIcon, spec.iconColor));
    iconSlot.append(iconEl);
  }
  row.append(iconSlot);

  const nameEl = document.createElement('span');
  nameEl.className = 'sub-name';
  nameEl.textContent = spec.name;
  const cmdEl = document.createElement('span');
  cmdEl.className = 'sub-cmd';
  cmdEl.textContent = spec.commandLine;
  cmdEl.title = spec.commandLine;
  row.append(nameEl, cmdEl);

  const trail = document.createElement('span');
  trail.className = 'sub-trail';
  const tags = document.createElement('span');
  tags.className = 'sub-tags';
  const dot = document.createElement('span');
  dot.className = 'sub-running-dot';
  dot.title = 'En marcha';
  tags.append(...spec.tags, dot);

  const actions = document.createElement('div');
  actions.className = 'sub-actions';
  const editBtn = iconButton('pencil', 'Editar', 'sub-action-btn');
  editBtn.addEventListener('click', () => spec.edit());
  const moreBtn = iconButton('ellipsis', 'Más', 'sub-action-btn sub-more');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.addEventListener('click', () =>
    spec.openMenu(moreBtn, spec.menuEntries()),
  );
  actions.append(...spec.extraActions, editBtn, moreBtn);
  trail.append(tags, actions);
  row.append(trail);

  row.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.drag-handle, .sub-actions, [role="menu"]')) return;
    spec.edit();
  });
  return row;
}

function tag(text: string, kind: string, title?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `sub-tag is-${kind}`;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

export function autoTag(): HTMLSpanElement {
  return tag('Auto', 'auto', 'Arranca al iniciar DevBar');
}

const DAY = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/** «L–V» for a run of three or more days in a row, else the letters. */
function compactDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.length === 7) return 'Diario';
  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? 0;
  // Unique and sorted, so the span equals the count only for a run.
  if (sorted.length >= 3 && last - first === sorted.length - 1)
    return `${DAY[first]}–${DAY[last]}`;
  return sorted.map((d) => DAY[d] ?? '').join('');
}

/** The schedule as a tag («L–V 08:00», «+1» per extra rule), or null. */
export function scheduleTag(
  schedule: Schedule | null | undefined,
): HTMLSpanElement | null {
  const rules = schedule?.enabled ? schedule.rules : [];
  const first = rules[0];
  if (!first) return null;
  const extra = rules.length > 1 ? ` +${rules.length - 1}` : '';
  return tag(
    `${compactDays(first.days ?? [])} ${first.time}${extra}`,
    'schedule',
    `Programado: ${summarizeSchedule(schedule)}`,
  );
}
