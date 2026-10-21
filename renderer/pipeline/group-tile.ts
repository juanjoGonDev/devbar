import { userIcon } from '../icon.js';
import { normalizeIconColor } from '../../src/icon-color.js';
import type { Group } from '../../src/domain-types.js';

/**
 * A group's icon on a small rounded tile washed in the group's own colour —
 * how the pipeline canvas, its panel and picker, and the new-pre-script
 * dialog tell one group's scripts from another's at a glance.
 */
export function fillGroupTile(tile: HTMLElement, group: Group | null): void {
  const color = normalizeIconColor(group?.iconColor);
  if (color) tile.style.setProperty('--tile-color', color);
  else tile.style.removeProperty('--tile-color');
  tile.replaceChildren(
    userIcon(group?.icon ?? null, 'package', group?.iconColor ?? null),
  );
}

export function groupTile(group: Group | null, extra = ''): HTMLSpanElement {
  const tile = document.createElement('span');
  tile.className = `group-tile ${extra}`.trim();
  fillGroupTile(tile, group);
  return tile;
}
