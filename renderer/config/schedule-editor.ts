import { createScheduleEditor } from '../schedule/schedule-editor.js';
import type {
  Action,
  Command,
  PreScript,
  Schedule,
} from '../../src/domain-types.js';

/**
 * The side sheet's «Programación» section: the switch in its header turns
 * the schedule on, and the shared schedule editor (renderer/schedule/) fills
 * its body. Nothing is saved from here: the sheet reads `readSchedule()`
 * when it submits.
 */

/** The sub-dialog's schedule block, as the window's markup declares it. */
export interface ScheduleEditorElements {
  group: HTMLElement;
  /** The switch in the section header. */
  enabled: HTMLInputElement;
  /** Shown only while the switch is on. */
  details: HTMLElement;
  /** Where the editor component goes. */
  mount: HTMLElement;
}

export interface ScheduleSection {
  /**
   * Show + populate the schedule editor. Available for commands and actions,
   * hidden for pre-scripts (a prep step isn't a thing you run at a clock time).
   */
  setup(
    item: Command | Action | PreScript | null | undefined,
    isPreScript: boolean,
  ): void;
  /** The whole block as the form submits it. */
  readSchedule(): Schedule;
}

const NO_SCHEDULE: Schedule = { enabled: false, rules: [], interval: null };

export function createScheduleSection(
  els: ScheduleEditorElements,
  now: () => number = Date.now,
): ScheduleSection {
  const editor = createScheduleEditor({
    value: NO_SCHEDULE,
    defaultRule: { time: '09:00', days: [] },
    now,
  });
  els.mount.replaceChildren(editor.element);

  const sync = (): void => {
    els.details.style.display = els.enabled.checked ? '' : 'none';
  };
  els.enabled.addEventListener('change', sync);

  function setup(
    item: Command | Action | PreScript | null | undefined,
    isPreScript: boolean,
  ): void {
    els.group.style.display = isPreScript ? 'none' : '';
    if (isPreScript) return;
    const schedule = item && 'schedule' in item ? item.schedule : NO_SCHEDULE;
    els.enabled.checked = schedule.enabled;
    editor.set({
      rules: Array.isArray(schedule.rules) ? schedule.rules : [],
      interval: schedule.interval ?? null,
    });
    sync();
  }

  function readSchedule(): Schedule {
    return { enabled: els.enabled.checked, ...editor.value() };
  }

  return { setup, readSchedule };
}
