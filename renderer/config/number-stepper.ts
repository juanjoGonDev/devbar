/**
 * A number field with a compact −/+ stepper around it (`.num-stepper`, see
 * config.html). The bounds and the step come from the input's own `min`,
 * `max` and `step`, so the markup stays the one place they are written.
 *
 * - The buttons step onto the step grid (1234 → 1300 / 1200, like the native
 *   arrows would) and commit at once: they fire the input's `change`.
 * - ArrowUp/ArrowDown step the same way but leave the commit to the field's
 *   own change/blur, as typing does.
 * - A typed value is clamped into range on `change`, before anyone saving on
 *   that event reads it. A blank field stays blank for the caller to resolve.
 */
export interface NumberStepper {
  /** Re-reads the value after a programmatic write (a settings load). */
  refresh(): void;
}

export function wireNumberStepper(input: HTMLInputElement): NumberStepper {
  const box = input.closest('.num-stepper');
  const dec = box?.querySelector<HTMLButtonElement>('[data-step="-1"]');
  const inc = box?.querySelector<HTMLButtonElement>('[data-step="1"]');
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 1;

  const clamp = (value: number): number => Math.min(max, Math.max(min, value));
  const current = (): number | null => {
    const value = Number.parseFloat(input.value);
    return Number.isFinite(value) ? value : null;
  };

  function paint(): void {
    const value = current();
    if (dec) dec.disabled = value !== null && value <= min;
    if (inc) inc.disabled = value !== null && value >= max;
  }

  function stepBy(direction: -1 | 1): void {
    const value = current() ?? min;
    const onGrid =
      direction === 1
        ? (Math.floor(value / step) + 1) * step
        : (Math.ceil(value / step) - 1) * step;
    input.value = String(clamp(onGrid));
    paint();
  }

  for (const [button, direction] of [
    [dec, -1],
    [inc, 1],
  ] as const)
    button?.addEventListener('click', () => {
      stepBy(direction);
      input.dispatchEvent(new Event('change'));
    });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    stepBy(event.key === 'ArrowUp' ? 1 : -1);
  });
  input.addEventListener('change', () => {
    const value = current();
    if (value !== null) input.value = String(clamp(Math.floor(value)));
    paint();
  });
  input.addEventListener('input', paint);
  paint();
  return { refresh: paint };
}
