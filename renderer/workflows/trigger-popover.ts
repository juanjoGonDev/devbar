import { icon } from '../icon.js';
import {
  createScheduleEditor,
  type ScheduleEditor,
} from '../schedule/schedule-editor.js';
import { MANUAL_TRIGGER, TRIGGER_META } from './trigger-meta.js';
import type {
  ScheduleRule,
  Workflow,
  WorkflowSchedule,
  WorkflowTrigger,
} from '../../src/domain-types.js';
import type { WorkflowEntry } from '../../src/ipc-contract.js';

/**
 * The trigger node's popover (the TriggerConfig mock): a segmented choice of
 * Al arrancar | Programado | Manual, then what that kind needs — the
 * «Ya lo usa …» swap for a startup slot another workflow holds, the shared
 * schedule editor (renderer/schedule/) for a schedule, whether a manual one
 * asks first. Where the workflow shows is the list's eye, not this.
 * Every change is saved at once through `save`; main's answer repaints it.
 */

type Kind = WorkflowTrigger['kind'];

/** What the popover changes on the workflow. */
type TriggerPatch = Pick<Workflow, 'trigger'>;

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

const DEFAULT_RULE: ScheduleRule = { time: '09:00', days: [1, 2, 3, 4, 5] };
/** How many of its own saves the editor recognises when main echoes them. */
const ECHOES_KEPT = 20;

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
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
): HTMLElement {
  const row = el('label', 'wf-pop-row');
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

  /**
   * The schedule editor lives as long as the popover shows a schedule, so a
   * repaint after each save keeps its focus, its open picker and the mode it
   * is not showing. Main's answer to one of its own saves is not loaded back
   * (a later keystroke may already be ahead of it); anything else is.
   */
  let editor: ScheduleEditor | null = null;
  let echoes: string[] = [];

  function scheduleEditor(schedule: WorkflowSchedule): ScheduleEditor {
    const incoming = JSON.stringify(schedule);
    if (!editor) {
      echoes = [];
      editor = createScheduleEditor({
        value: schedule,
        defaultRule: DEFAULT_RULE,
        now: deps.now,
        onChange: (next) => {
          echoes = [...echoes, JSON.stringify(next)].slice(-ECHOES_KEPT);
          saveTrigger({ kind: 'schedule', schedule: next });
        },
      });
    } else if (
      !echoes.includes(incoming) &&
      JSON.stringify(editor.value()) !== incoming
    )
      editor.set(schedule);
    return editor;
  }

  function manualBody(
    trigger: Extract<WorkflowTrigger, { kind: 'manual' }>,
  ): HTMLElement[] {
    return [
      switchRow('Pedir confirmación antes de ejecutar', trigger.confirm, (on) =>
        saveTrigger({ ...trigger, confirm: on }),
      ),
    ];
  }

  /** Rebuilt on every repaint, unlike `body`, which may hold the editor. */
  const head = el('div', 'wf-pop-part');
  const body = el('div', 'wf-pop-part');
  root.append(head, body);

  function refresh(): void {
    if (root.hidden) return;
    const trigger = current();
    const shown = picked ?? trigger.kind;
    head.replaceChildren(
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
    );
    const scheduled = shown === 'schedule' && trigger.kind === 'schedule';
    root.classList.toggle('is-schedule', scheduled);
    if (!scheduled) editor = null;
    if (scheduled) {
      const { element } = scheduleEditor(trigger.schedule);
      if (body.firstChild !== element || body.childNodes.length !== 1)
        body.replaceChildren(element);
    } else if (shown === 'startup') body.replaceChildren(...startupBody());
    else if (trigger.kind === 'manual')
      body.replaceChildren(...manualBody(trigger));
    else body.replaceChildren();
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
      // A fresh editor: nothing kept from the last time it was open.
      editor = null;
      refresh();
      root.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    },
    close,
    isOpen: () => !root.hidden,
    refresh,
  };
}
