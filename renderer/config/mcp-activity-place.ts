/**
 * Keeps an open column menu of «Actividad» inside the window. The view does
 * not scroll while «Actividad» shows (only its rows do), so a menu taller than
 * the room under its header would be cut off: the menu is capped at that room
 * and scrolls inside itself instead.
 *
 * The «Rango…» picker of «Hora» does not fit in the menu at all, so it opens
 * in a flyout (`.xf-fly`) beside it: `position: fixed`, so no ancestor's
 * overflow can clip it, to the right of the menu with its top on the «Filtrar»
 * section — or to the left when the right has no room — and shifted up when
 * it would pass the bottom of the window. The flyout stays a child of the
 * menu, so it is part of the same dialog, comes next in the Tab order and
 * counts as inside the menu for every click.
 *
 * jsdom has no layout: everything is read from getBoundingClientRect and the
 * window size, which a test can stub.
 */

/** The space kept free between a menu or its flyout and the window's edge. */
const EDGE = 12;
/** The gap between the menu and its flyout. */
const GAP = 6;

/** Right of the menu, else left of it, else as far right as it still fits. */
function flyoutLeft(box: DOMRect, width: number): number {
  const right = box.right + GAP;
  if (right + width <= window.innerWidth - EDGE) return right;
  const left = box.left - GAP - width;
  if (left >= EDGE) return left;
  return Math.max(EDGE, window.innerWidth - EDGE - width);
}

function placeFlyout(menu: HTMLElement, fly: HTMLElement): void {
  const box = menu.getBoundingClientRect();
  const anchor = fly.closest<HTMLElement>('.xf-sec') ?? menu;
  const { width, height } = fly.getBoundingClientRect();
  const x = flyoutLeft(box, width);
  const lowest = window.innerHeight - EDGE - height;
  const y = Math.max(
    EDGE,
    Math.min(anchor.getBoundingClientRect().top, lowest),
  );
  fly.style.left = `${Math.round(x)}px`;
  fly.style.top = `${Math.round(y)}px`;
}

/** Caps `menu` at the room below its top and places its flyout, if any. */
export function placeMenu(menu: HTMLElement): void {
  const { top } = menu.getBoundingClientRect();
  const room = Math.max(0, Math.floor(window.innerHeight - top - EDGE));
  menu.style.maxHeight = `${room}px`;
  const fly = menu.querySelector<HTMLElement>('.xf-fly');
  if (fly) placeFlyout(menu, fly);
}
