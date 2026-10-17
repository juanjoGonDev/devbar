/**
 * The drag-to-resize behaviour of a `role="separator"` handle, shared by the
 * groups list's divider and the pipeline's floating pre-scripts panel: a
 * pointer drag previews the width live and commits it on release (only if
 * the pointer actually moved), and ←/→ commit a step at a time.
 *
 * Also the localStorage plumbing both persist their width through, wrapped so
 * a blocked or missing storage only costs the preference, never the window.
 */

const KEY_STEP = 16;

export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, width)));
}

export interface ResizeHandleOptions {
  handle: HTMLElement;
  min: number;
  max: number;
  /** The width the handle currently stands at. */
  current(): number;
  /** Paints a width while dragging; nothing is stored yet. */
  preview(width: number): void;
  /** The width the user settled on. */
  commit(width: number): void;
  onDragStart?(): void;
  onDragEnd?(): void;
}

export function attachResizeHandle(options: ResizeHandleOptions): void {
  const { handle } = options;
  handle.setAttribute('aria-valuemin', String(options.min));
  handle.setAttribute('aria-valuemax', String(options.max));
  const clamp = (width: number): number =>
    clampWidth(width, options.min, options.max);

  handle.addEventListener('keydown', (event) => {
    const step =
      event.key === 'ArrowRight'
        ? KEY_STEP
        : event.key === 'ArrowLeft'
          ? -KEY_STEP
          : 0;
    if (!step) return;
    event.preventDefault();
    options.commit(clamp(options.current() + step));
  });

  handle.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    down.stopPropagation();
    const startX = down.clientX;
    const startWidth = options.current();
    let moved = false;
    options.onDragStart?.();
    const onMove = (move: PointerEvent): void => {
      moved = moved || move.clientX !== startX;
      options.preview(clamp(startWidth + move.clientX - startX));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      options.onDragEnd?.();
      if (moved) options.commit(options.current());
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

export function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value`, or forgets the key when it is null. */
export function writeStoredValue(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* localStorage unavailable — the choice lasts for this session only */
  }
}
