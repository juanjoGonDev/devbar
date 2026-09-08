export type SelectMode = 'replace' | 'toggle' | 'range';

export interface Modifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export interface Selection {
  selected: ReadonlySet<number>;
  anchor: number | null;
}

/** Windows/Finder semantics: shift extends, cmd/ctrl toggles, plain replaces. */
export function selectModeFor(ev: Modifiers): SelectMode {
  if (ev.shiftKey) return 'range';
  if (ev.metaKey || ev.ctrlKey) return 'toggle';
  return 'replace';
}

/**
 * Next selection after clicking row `index`. Indices are positions in the
 * currently visible list, so the caller re-derives them on every click.
 * A range click keeps the anchor, so repeated shift-clicks grow and shrink
 * the same range instead of walking it.
 */
export function applySelection(
  prev: Selection,
  index: number,
  mode: SelectMode,
): Selection {
  if (mode === 'range' && prev.anchor !== null) {
    const lo = Math.min(prev.anchor, index);
    const hi = Math.max(prev.anchor, index);
    const selected = new Set<number>();
    for (let i = lo; i <= hi; i += 1) selected.add(i);
    return { selected, anchor: prev.anchor };
  }
  if (mode === 'toggle') {
    const selected = new Set(prev.selected);
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
    return { selected, anchor: index };
  }
  return { selected: new Set([index]), anchor: index };
}
