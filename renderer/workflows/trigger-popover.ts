import { icon, type IconName } from '../icon.js';
import { nextRunText } from './list-model.js';
import { MANUAL_TRIGGER, TRIGGER_META } from './trigger-meta.js';
import { nextWorkflowRun } from '../../src/scheduler.js';
import type {
  ScheduleInterval,
  ScheduleRule,
  Workflow,
  WorkflowSchedule,
  WorkflowTrigger,
} from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

/**
 * The trigger node's popover (the TriggerConfig mock): a segmented choice of
 * Al arrancar | Programado | Manual, then what that kind needs — the
 * «Ya lo usa …» swap for a startup slot another workflow holds, weekday chips
 * and a time or an «every N» interval for a schedule, whether a manual one
 * asks first — and, for every kind, where the workflow shows (tray, phone).
 * Every change is saved at once through `save`; main's answer repaints it.
 */

type Kind = WorkflowTrigger['kind'];

/** What the popover changes on the workflow. */
type TriggerPatch = Partial<
  Pick<Workflow, 'trigger' | 'showInTray' | 'showInRemote'>
>;

export interface TriggerPopoverDeps {
  /** Positioned inside this element. */
  host: HTMLElement;
  workflow: () => Workflow | null;
  entries: () => readonly WorkflowEntry[];
  save: (patch: TriggerPatch) => void;
  /** «Usar este en su lugar»: take the startup slot from its holder. */
  takeStartup: () => void;
  now: () => number;
  /** The trigger node as drawn now (the canvas repaints it often). */
  anchor: () => HTMLElement | null;
}

export interface TriggerPopover {
  open(at: { x: number; y: number }): void;
  close(): void;
  isOpen(): boolean;
  /** Repaints from the workflow as it stands now. */
  refresh(): void;
}

const DAYS: ReadonlyArray<[string, number]> = [
  ['L', 1],
  ['M', 2],
  ['X', 3],
  ['J', 4],
  ['V', 5],
  ['S', 6],
  ['D', 0],
];

const DEFAULT_RULE: ScheduleRule = { time: '09:00', days: [1, 2, 3, 4, 5] };
const DEFAULT_INTERVAL: ScheduleInterval = { every: 1, unit: 'hours' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function segmented(
  className: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  current: string,
  onPick: (value: string) => void,
): HTMLElement {
  const group = el('div', `wf-seg ${className}`);
  group.setAttribute('role', 'radiogroup');
  for (const option of options) {
    const button = el('button', 'wf-seg-option', option.label);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(option.value === current));
    button.addEventListener('click', () => onPick(option.value));
    group.append(button);
  }
  return group;
}

function switchRow(
  glyph: IconName | null,
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
): HTMLElement {
  const row = el('label', 'wf-pop-row');
  if (glyph) row.append(icon(glyph));
  const text = el('span', 'wf-pop-grow', label);
  const toggle = el('input', 'remote-switch');
  toggle.type = 'checkbox';
  toggle.setAttribute('role', 'switch');
  toggle.checked = checked;
  toggle.addEventListener('change', () => onChange(toggle.checked));
  row.append(text, toggle);
  return row;
}

export function createTriggerPopover(deps: TriggerPopoverDeps): TriggerPopover {
  const root = el('div', 'wf-pop');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Desencadenante');
  root.hidden = true;
  deps.host.append(root);
  /** A kind picked but not saved: the startup slot is someone else's. */
  let picked: Kind | null = null;

  const current = (): WorkflowTrigger =>
    deps.workflow()?.trigger ?? MANUAL_TRIGGER;
  const saveTrigger = (trigger: WorkflowTrigger): void =>
    deps.save({ trigger });

  function startupHolder(): Workflow | null {
    const own = deps.workflow()?.id;
    return (
      deps
        .entries()
        .map((entry) => entry.workflow)
        .find((w) => w.trigger.kind === 'startup' && w.id !== own) ?? null
    );
  }

  function pick(kind: Kind): void {
    if (kind === current().kind) {
      picked = null;
      refresh();
      return;
    }
    if (kind === 'startup' && startupHolder()) {
      picked = 'startup';
      refresh();
      return;
    }
    picked = null;
    if (kind === 'startup') saveTrigger({ kind: 'startup' });
    else if (kind === 'manual') saveTrigger(MANUAL_TRIGGER);
    else
      saveTrigger({
        kind: 'schedule',
        schedule: { rules: [DEFAULT_RULE], interval: null },
      });
  }

  function startupBody(): HTMLElement[] {
    const holder = startupHolder();
    if (!holder || current().kind === 'startup') return [];
    const warn = el('div', 'wf-pop-warn');
    const text = el('div', 'wf-pop-warn-text');
    const swap = el('button', 'wf-pop-swap', 'Usar este en su lugar');
    swap.type = 'button';
    swap.addEventListener('click', () => {
      picked = null;
      deps.takeStartup();
    });
    text.append(el('span', '', `Ya lo usa «${holder.name}».`), swap);
    warn.append(icon('circle-alert'), text);
    return [warn];
  }

  function scheduleBody(schedule: WorkflowSchedule): HTMLElement[] {
    const save = (next: WorkflowSchedule): void =>
      saveTrigger({ kind: 'schedule', schedule: next });
    const mode =
      schedule.rules.length === 0 && schedule.interval ? 'every' : 'at';
    const parts: HTMLElement[] = [
      segmented(
        'is-sub',
        [
          { value: 'at', label: 'A una hora' },
          { value: 'every', label: 'Cada…' },
        ],
        mode,
        (value) => {
          if (value === mode) return;
          save(
            value === 'every'
              ? { rules: [], interval: schedule.interval ?? DEFAULT_INTERVAL }
              : { rules: [DEFAULT_RULE], interval: null },
          );
        },
      ),
    ];
    if (mode === 'at') {
      const rule = schedule.rules[0] ?? DEFAULT_RULE;
      const rest = schedule.rules.slice(1);
      const setRule = (next: ScheduleRule): void =>
        save({ rules: [next, ...rest], interval: schedule.interval });
      const chips = el('div', 'wf-days');
      for (const [letter, day] of DAYS) {
        const on = rule.days.includes(day);
        const chip = el('button', 'wf-day', letter);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', String(on));
        chip.addEventListener('click', () =>
          setRule({
            ...rule,
            days: on
              ? rule.days.filter((d) => d !== day)
              : [...rule.days, day].sort((a, b) => a - b),
          }),
        );
        chips.append(chip);
      }
      const row = el('label', 'wf-pop-row');
      const time = el('input', 'wf-time');
      time.type = 'time';
      time.value = rule.time;
      time.addEventListener('change', () => {
        if (time.value) setRule({ ...rule, time: time.value });
      });
      row.append(el('span', 'wf-pop-grow', 'Hora'), time);
      parts.push(chips, row);
    } else {
      const interval = schedule.interval ?? DEFAULT_INTERVAL;
      const row = el('div', 'wf-pop-row');
      const every = el('input', 'wf-every');
      every.type = 'number';
      every.min = '1';
      every.value = String(interval.every);
      every.setAttribute('aria-label', 'Cada');
      const unit = el('select', 'wf-unit');
      unit.setAttribute('aria-label', 'Unidad');
      for (const [value, label] of [
        ['minutes', 'minutos'],
        ['hours', 'horas'],
      ] as const) {
        const option = el('option', '', label);
        option.value = value;
        option.selected = interval.unit === value;
        unit.append(option);
      }
      const commit = (): void => {
        const n = Math.round(Number(every.value));
        if (!Number.isFinite(n) || n < 1) return;
        save({
          rules: schedule.rules,
          interval: {
            every: n,
            unit: unit.value === 'minutes' ? 'minutes' : 'hours',
          },
        });
      };
      every.addEventListener('change', commit);
      unit.addEventListener('change', commit);
      row.append(el('span', 'wf-pop-grow', 'Cada'), every, unit);
      parts.push(row);
    }
    const lastRun = deps
      .entries()
      .find((e) => e.workflow.id === deps.workflow()?.id)?.lastRun;
    const next = nextWorkflowRun(
      schedule,
      lastRun ? new Date(lastRun.startedAt).toISOString() : null,
      new Date(deps.now()),
    );
    if (next) {
      const row = el('div', 'wf-pop-next');
      const text = el('span', '', 'Próxima: ');
      text.append(el('strong', '', nextRunText(next.getTime(), deps.now())));
      row.append(icon('calendar'), text);
      parts.push(row);
    }
    return parts;
  }

  function manualBody(
    trigger: Extract<WorkflowTrigger, { kind: 'manual' }>,
  ): HTMLElement[] {
    return [
      switchRow(
        null,
        'Pedir confirmación antes de ejecutar',
        trigger.confirm,
        (on) => saveTrigger({ ...trigger, confirm: on }),
      ),
    ];
  }

  /** Where the workflow shows, whatever its trigger. */
  function visibilityBody(): HTMLElement[] {
    const workflow = deps.workflow();
    return [
      el('div', 'wf-pop-divider'),
      el('div', 'wf-pop-label', 'Mostrar en'),
      switchRow(
        'panel-top',
        'Menú de la barra',
        workflow?.showInTray ?? true,
        (on) => deps.save({ showInTray: on }),
      ),
      switchRow(
        'smartphone',
        'Control remoto',
        workflow?.showInRemote ?? false,
        (on) => deps.save({ showInRemote: on }),
      ),
    ];
  }

  function refresh(): void {
    if (root.hidden) return;
    const trigger = current();
    const shown = picked ?? trigger.kind;
    const body: HTMLElement[] = [
      el('div', 'wf-pop-label', 'Desencadenante'),
      segmented(
        '',
        (['startup', 'schedule', 'manual'] as const).map((kind) => ({
          value: kind,
          label: TRIGGER_META[kind].pill,
        })),
        shown,
        (value) => pick(value as Kind),
      ),
    ];
    if (shown === 'startup') body.push(...startupBody());
    else if (trigger.kind === 'schedule')
      body.push(...scheduleBody(trigger.schedule));
    else if (trigger.kind === 'manual') body.push(...manualBody(trigger));
    if (shown === trigger.kind) body.push(...visibilityBody());
    root.replaceChildren(...body);
  }

  function close(): void {
    if (root.hidden) return;
    root.hidden = true;
    picked = null;
    deps.anchor()?.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node | null;
    if (root.hidden || root.contains(target) || deps.anchor()?.contains(target))
      return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (root.hidden || event.key !== 'Escape') return;
    event.stopPropagation();
    close();
    deps.anchor()?.focus({ preventScroll: true });
  });

  return {
    open: (at) => {
      root.style.left = `${Math.max(12, at.x)}px`;
      root.style.top = `${at.y}px`;
      root.hidden = false;
      deps.anchor()?.setAttribute('aria-expanded', 'true');
      picked = null;
      refresh();
      root.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    },
    close,
    isOpen: () => !root.hidden,
    refresh,
  };
}
