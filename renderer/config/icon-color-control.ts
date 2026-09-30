import {
  ICON_COLOR_PRESETS,
  normalizeIconColor,
} from '../../src/icon-color.js';
import { icon } from '../icon.js';

/**
 * The colour of a user icon, as a split button: the icon button itself and a
 * narrow colour segment joined under one border. The segment shows the
 * current colour as a dot and opens a small palette — the presets, "Sin
 * color" (back to the text colour) and "Personalizado" (the native colour
 * input). The segment hides while the icon is an uploaded image, which a
 * colour cannot tint.
 */
export interface IconColorControl {
  /** The split button; it holds `iconBtn`. */
  el: HTMLElement;
  value(): string | null;
  /** Shows `value` as selected; does not report it. */
  set(value: string | null): void;
  setImage(isImage: boolean): void;
}

const COLUMNS = 6;

const ARROW_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -COLUMNS,
  ArrowDown: COLUMNS,
};

function cell(className: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.tabIndex = -1;
  return btn;
}

/**
 * Wraps `iconBtn` (taking its place if it is already in the page) with the
 * colour segment. `onChange` gets every colour the user picks.
 */
export function createIconColorControl(
  iconBtn: HTMLButtonElement,
  onChange: (value: string | null) => void,
): IconColorControl {
  let current: string | null = null;
  const el = document.createElement('div');
  el.className = 'icon-split';
  iconBtn.replaceWith(el);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'icon-color-trigger';
  trigger.title = 'Color del icono';
  trigger.setAttribute('aria-label', trigger.title);
  trigger.setAttribute('aria-haspopup', 'true');
  const dot = document.createElement('span');
  dot.className = 'icon-color-dot';
  trigger.append(dot, icon('chevron-down'));

  const popover = document.createElement('div');
  popover.className = 'icon-color-popover';
  popover.setAttribute('role', 'group');
  popover.setAttribute('aria-label', 'Color del icono');
  // Focusable, so a click on the palette's padding keeps focus inside it.
  popover.tabIndex = -1;

  // Only the element's inline style carries the colour: the shorthand also
  // sets background-image to none, beating the base button gradient, and
  // inline styles are allowed by the windows' `style-src 'unsafe-inline'`.
  const swatches = ICON_COLOR_PRESETS.map((preset) => {
    const btn = cell('icon-color-swatch', preset.label);
    btn.dataset.color = preset.value;
    btn.style.background = preset.value;
    btn.addEventListener('click', () => pick(preset.value));
    return btn;
  });

  const reset = cell('icon-color-reset', 'Sin color');
  reset.append(icon('ban'));
  reset.addEventListener('click', () => pick(null));

  // The native input stays out of the palette (visually hidden), so closing
  // the palette never takes the OS colour panel down with it.
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'icon-color-custom';
  custom.tabIndex = -1;
  custom.setAttribute('aria-hidden', 'true');
  custom.addEventListener('input', () => choose(custom.value));

  const customBtn = cell('icon-color-custom-btn', 'Personalizado');
  customBtn.append(icon('plus'));
  customBtn.addEventListener('click', () => {
    if (current) custom.value = current;
    custom.click();
  });

  const cells = [...swatches, reset, customBtn];
  popover.append(...cells);
  el.append(iconBtn, trigger, popover, custom);

  function onOutsidePointer(e: Event): void {
    if (!(e.target instanceof Node) || !el.contains(e.target)) close();
  }

  function open(): void {
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutsidePointer, true);
    const selected =
      cells.find((c) => c.getAttribute('aria-pressed') === 'true') ?? cells[0];
    selected?.focus();
  }

  function close(): void {
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointer, true);
  }

  trigger.addEventListener('click', () => {
    if (popover.hidden) open();
    else close();
  });

  popover.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger.focus();
      return;
    }
    const step = ARROW_STEP[e.key];
    if (step === undefined) return;
    const from = cells.indexOf(document.activeElement as HTMLButtonElement);
    const next = cells[from + step];
    if (from < 0 || !next) return;
    e.preventDefault();
    next.focus();
  });

  el.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to instanceof Node && el.contains(to)) return;
    // The native colour input takes focus while the OS panel is up.
    if (to === null && document.activeElement === custom) return;
    close();
  });

  function set(value: string | null): void {
    current = normalizeIconColor(value);
    let preset = false;
    for (const swatch of swatches) {
      const on = swatch.dataset.color === current;
      preset ||= on;
      swatch.setAttribute('aria-pressed', String(on));
    }
    const isCustom = current !== null && !preset;
    customBtn.setAttribute('aria-pressed', String(isCustom));
    reset.setAttribute('aria-pressed', String(current === null));
    dot.style.background = current ?? '';
    dot.classList.toggle('is-empty', current === null);
  }

  function choose(value: string | null): void {
    set(value);
    close();
    onChange(current);
  }

  /** A palette pick: focus goes back to the segment, not a hidden cell. */
  function pick(value: string | null): void {
    choose(value);
    trigger.focus();
  }

  set(null);
  close();
  return {
    el,
    value: () => current,
    set,
    setImage: (isImage) => {
      if (isImage) close();
      trigger.hidden = isImage;
      el.classList.toggle('is-image', isImage);
    },
  };
}
