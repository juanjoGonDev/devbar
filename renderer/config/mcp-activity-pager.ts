import { icon, type IconName } from '../icon.js';

/**
 * The foot of the «Actividad» table: «1–50 de 1.284», and the pages — the
 * previous and next arrows around the first, the last and the ones next to
 * the current page, with «…» where numbers are skipped.
 */

export interface PagerElements {
  range: HTMLElement;
  pages: HTMLElement;
}

export const NUMBER = new Intl.NumberFormat('es-ES');

/** The page numbers to offer, `null` where a run of them is skipped. */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const shown = [
    ...new Set(
      [1, page - 1, page, page + 1, pages].filter((p) => p >= 1 && p <= pages),
    ),
  ].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  shown.forEach((p, index) => {
    const before = shown[index - 1];
    if (before !== undefined && p - before > 1) out.push(null);
    out.push(p);
  });
  return out;
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

function arrow(
  name: IconName,
  label: string,
  disabled: boolean,
  go: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.disabled = disabled;
  button.addEventListener('click', go);
  return button;
}

export function renderPager(
  els: PagerElements,
  view: { page: number; size: number; total: number; shown: number },
  go: (page: number) => void,
): void {
  const { page, size, total, shown } = view;
  const start = (page - 1) * size;
  els.range.textContent =
    total > 0 && shown > 0
      ? `${NUMBER.format(start + 1)}–${NUMBER.format(start + shown)} de ${NUMBER.format(total)}`
      : '0 entradas';
  const pages = pageCount(total, size);
  const items: HTMLElement[] = [
    arrow('chevron-left', 'Página anterior', page <= 1, () => go(page - 1)),
  ];
  for (const p of pageNumbers(page, pages)) {
    if (p === null) {
      const gap = document.createElement('span');
      gap.className = 'gap';
      gap.textContent = '…';
      gap.setAttribute('aria-hidden', 'true');
      items.push(gap);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(p);
    button.setAttribute('aria-label', `Página ${p}`);
    if (p === page) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => go(p));
    items.push(button);
  }
  items.push(
    arrow('chevron-right', 'Página siguiente', page >= pages, () =>
      go(page + 1),
    ),
  );
  els.pages.replaceChildren(...items);
}
