/**
 * The weekday parts of the schedule editor: a 7-cell segmented control
 * (L M X J V S D, Monday first, one tab stop moved with the arrows) and the
 * «Laborables / Todos / Fin de semana» preset chips. Days are weekday
 * indexes, Sunday = 0; an empty list means every day.
 */

const WEEK: ReadonlyArray<{ letter: string; day: number; name: string }> = [
  { letter: 'L', day: 1, name: 'lunes' },
  { letter: 'M', day: 2, name: 'martes' },
  { letter: 'X', day: 3, name: 'miércoles' },
  { letter: 'J', day: 4, name: 'jueves' },
  { letter: 'V', day: 5, name: 'viernes' },
  { letter: 'S', day: 6, name: 'sábado' },
  { letter: 'D', day: 0, name: 'domingo' },
];

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const PRESETS: ReadonlyArray<{ label: string; days: number[] }> = [
  { label: 'Laborables', days: [1, 2, 3, 4, 5] },
  { label: 'Todos', days: ALL_DAYS },
  { label: 'Fin de semana', days: [0, 6] },
];

const sorted = (days: Iterable<number>): number[] =>
  [...new Set(days)].sort((a, b) => a - b);

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  const left = sorted(a.length === 0 ? ALL_DAYS : a);
  const right = sorted(b.length === 0 ? ALL_DAYS : b);
  return left.join(',') === right.join(',');
}

export interface DayPicker {
  element: HTMLElement;
  /** Repaints new days without reporting them. */
  set(days: readonly number[]): void;
}

export function createDayPicker(
  initial: readonly number[],
  onChange: (days: number[]) => void,
): DayPicker {
  let chosen = new Set(initial);
  const group = document.createElement('div');
  group.className = 'sched-days';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Días');
  const cells = WEEK.map(({ letter, day, name }, index) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'sched-day';
    cell.textContent = letter;
    cell.dataset.day = String(day);
    cell.setAttribute('aria-label', name);
    cell.tabIndex = index === 0 ? 0 : -1;
    cell.addEventListener('click', () => {
      if (chosen.has(day)) chosen.delete(day);
      else chosen.add(day);
      paint();
      onChange(sorted(chosen));
    });
    group.append(cell);
    return cell;
  });

  function focusCell(index: number): void {
    const target = cells[(index + cells.length) % cells.length];
    if (!target) return;
    for (const cell of cells) cell.tabIndex = cell === target ? 0 : -1;
    target.focus();
  }

  group.addEventListener('keydown', (event) => {
    const index = cells.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const moves: Partial<Record<string, number>> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: cells.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    focusCell(next);
  });

  function paint(): void {
    for (const cell of cells) {
      const on = chosen.has(Number(cell.dataset.day));
      cell.setAttribute('aria-pressed', String(on));
      cell.classList.toggle('is-on', on);
    }
  }

  paint();
  return {
    element: group,
    set(days) {
      chosen = new Set(days);
      paint();
    },
  };
}

export interface PresetChips {
  element: HTMLElement;
  /** Marks the preset these days match, if any. */
  highlight(days: readonly number[]): void;
}

export function createPresetChips(
  onPick: (days: number[]) => void,
): PresetChips {
  const row = document.createElement('div');
  row.className = 'sched-presets';
  const chips = PRESETS.map((preset) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sched-chip';
    chip.textContent = preset.label;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => onPick([...preset.days]));
    row.append(chip);
    return { chip, preset };
  });
  return {
    element: row,
    highlight(days) {
      for (const { chip, preset } of chips)
        chip.setAttribute('aria-pressed', String(sameDays(days, preset.days)));
    },
  };
}
