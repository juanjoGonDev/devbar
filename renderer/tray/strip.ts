import { icon, type IconName } from '../icon.js';

/**
 * The slim status strips under the popover's header row (update phase,
 * pipeline run). Each strip owns one fixed element in `tray.html`; these are
 * the small DOM pieces they share, so both read and behave the same.
 */

export function stripSpan(
  className: string,
  text?: string,
  title?: string,
): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  if (title) el.title = title;
  return el;
}

export function stripIcon(name: IconName, className: string): HTMLSpanElement {
  const el = icon(name);
  el.classList.add(className);
  return el;
}

/** An icon-only strip control; the label is its tooltip and accessible name. */
export function stripIconButton(
  className: string,
  name: IconName,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `ghost ${className}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(icon(name));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

export function stripTextButton(
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost strip-text-btn';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/**
 * The thin accent bar along a strip's bottom edge: `percent` fills it, null
 * runs it as an indeterminate sweep (work in progress of unknown length).
 */
export function stripProgress(percent: number | null): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'strip-progress';
  if (percent === null) bar.classList.add('indeterminate');
  else bar.style.width = `${percent}%`;
  return bar;
}

/**
 * Fills one strip, or hides it for `null`, then collapses the strip area when
 * no strip is left showing — an empty area would still eat its margins.
 */
export function paintStrip(
  strip: HTMLElement,
  children: readonly Node[] | null,
): void {
  strip.replaceChildren(...(children ?? []));
  strip.hidden = children === null;
  const area = strip.parentElement;
  if (area)
    area.hidden = Array.from(area.children).every(
      (el) => (el as HTMLElement).hidden,
    );
}
