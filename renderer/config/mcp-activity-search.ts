import { icon } from '../icon.js';

/**
 * The «Buscar en toda la actividad» field over the table. What is typed is
 * applied once the typing pauses (Enter applies it at once); ⌘F (Ctrl+F)
 * reaches it while the log is on screen, and its ✕ empties it.
 */

export interface SearchElements {
  input: HTMLInputElement;
  clear: HTMLButtonElement;
  shortcut: HTMLElement;
}

export interface SearchDeps {
  platform: string;
  /** The log is what the user is looking at, so ⌘F belongs to it. */
  shown(): boolean;
  apply(text: string): void;
}

export interface ActivitySearch {
  /** Empties the field without applying anything («Quitar todo» does). */
  reset(): void;
}

/** How long the typing has to pause before the search runs. */
export const SEARCH_DELAY_MS = 150;

export function createActivitySearch(
  els: SearchElements,
  deps: SearchDeps,
): ActivitySearch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let applied = '';

  if (deps.platform === 'darwin')
    els.shortcut.replaceChildren(icon('command'), 'F');
  else els.shortcut.textContent = 'Ctrl+F';

  const paint = (): void => {
    const empty = els.input.value === '';
    els.clear.hidden = empty;
    els.shortcut.hidden = !empty;
  };
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const now = (): void => {
    cancel();
    if (els.input.value === applied) return;
    applied = els.input.value;
    deps.apply(applied);
  };

  els.input.addEventListener('input', () => {
    paint();
    cancel();
    timer = setTimeout(now, SEARCH_DELAY_MS);
  });
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      now();
    }
  });
  els.clear.addEventListener('click', (event) => {
    event.preventDefault();
    els.input.value = '';
    paint();
    now();
    els.input.focus();
  });
  document.addEventListener('keydown', (event) => {
    const accel = event.metaKey || event.ctrlKey;
    if (!accel || event.altKey || event.key.toLowerCase() !== 'f') return;
    if (!deps.shown() || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    els.input.focus();
    els.input.select();
  });
  paint();

  return {
    reset() {
      cancel();
      els.input.value = '';
      applied = '';
      paint();
    },
  };
}
