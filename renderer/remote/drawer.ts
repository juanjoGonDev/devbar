import {
  endGesture,
  moveGesture,
  startGesture,
  type Gesture,
  type Sample,
} from './drawer-gesture.js';

/**
 * The phone's side menu: the DOM side of renderer/remote/drawer-gesture.ts.
 * It opens from the menu button or a swipe from the left edge, and closes
 * from the backdrop, Escape, a swipe back to the left, or a pick. While open
 * the rest of the panel is inert and the keyboard stays inside the menu;
 * focus goes into it on open and back to the menu button on close.
 *
 * Every listener sits on the panel itself (a touch stays with the element it
 * started on, and focus is inside the panel while the menu is open), so a
 * page that reloads the panel leaves nothing listening behind.
 *
 * The state lives on the panel (`data-drawer`: closed, open, dragging) and,
 * mid-drag, in `--drawer-progress`: remote.css does the sliding, and skips
 * the animation under prefers-reduced-motion.
 */

export interface DrawerElements {
  /** The linked panel: carries the state, and listens for the swipe. */
  root: HTMLElement;
  /** Everything behind the menu. */
  main: HTMLElement;
  drawer: HTMLElement;
  backdrop: HTMLElement;
  button: HTMLButtonElement;
}

export interface Drawer {
  open(): void;
  close(): void;
}

/** Used when layout gives no width (never on a phone). */
const FALLBACK_WIDTH = 286;

export function createDrawer(
  els: DrawerElements,
  deps: { now(): number },
): Drawer {
  let open = false;
  let gesture: Gesture | null = null;
  /** A drag just ended: the click it may produce is not a tap. */
  let swallowClick = false;

  const width = (): number =>
    els.drawer.getBoundingClientRect().width || FALLBACK_WIDTH;
  const items = (): HTMLElement[] => [
    ...els.drawer.querySelectorAll<HTMLElement>('button:not([disabled])'),
  ];

  function settle(next: boolean): void {
    const was = open;
    open = next;
    els.root.dataset.drawer = next ? 'open' : 'closed';
    els.root.style.removeProperty('--drawer-progress');
    els.button.setAttribute('aria-expanded', String(next));
    els.main.toggleAttribute('inert', next);
    if (next) els.main.setAttribute('aria-hidden', 'true');
    else els.main.removeAttribute('aria-hidden');
    els.drawer.toggleAttribute('inert', !next);
    if (next && !was) {
      const current =
        els.drawer.querySelector<HTMLElement>('[aria-current="page"]') ??
        items()[0];
      current?.focus();
    } else if (!next && was) els.button.focus();
  }

  const sample = (event: PointerEvent): Sample => ({
    x: event.clientX,
    y: event.clientY,
    t: deps.now(),
  });

  els.root.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button))
      return;
    if (document.querySelector('dialog[open]')) return;
    gesture = startGesture(sample(event), open);
  });
  els.root.addEventListener('pointermove', (event) => {
    if (!gesture || !event.isPrimary) return;
    gesture = moveGesture(gesture, sample(event), width());
    if (gesture.phase !== 'dragging') return;
    els.root.dataset.drawer = 'dragging';
    els.root.style.setProperty('--drawer-progress', String(gesture.progress));
  });
  els.root.addEventListener('pointerup', (event) => {
    if (!gesture || !event.isPrimary) return;
    const ended = moveGesture(gesture, sample(event), width());
    gesture = null;
    const next = endGesture(ended, width());
    if (next === null) return;
    swallowClick = true;
    window.setTimeout(() => {
      swallowClick = false;
    }, 0);
    settle(next);
  });
  // The browser took the touch over (a scroll): back to where it was.
  els.root.addEventListener('pointercancel', () => {
    if (!gesture) return;
    const dragging = gesture.phase === 'dragging';
    gesture = null;
    if (dragging) settle(open);
  });
  els.root.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );

  els.button.addEventListener('click', () => settle(!open));
  els.backdrop.addEventListener('click', () => settle(false));
  els.root.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      settle(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const list = items();
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = active instanceof Node && els.drawer.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  });

  return {
    open: () => settle(true),
    close: () => settle(false),
  };
}
