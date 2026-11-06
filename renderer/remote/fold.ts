import { plural } from './format.js';
import { glyph } from './glyphs.js';
import { el } from './view.js';

/**
 * «N oculto(s)»: the fold the phone keeps the groups and workflows hidden
 * from the tray behind, closed like the tray's until tapped.
 */
export function foldToggle(
  count: number,
  open: boolean,
  flip: () => void,
): HTMLButtonElement {
  const toggle = el('button', 'hidden-groups-toggle');
  toggle.type = 'button';
  toggle.addEventListener('click', flip);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.append(
    glyph('chevron', 14),
    el('span', '', plural(count, 'oculto', 'ocultos')),
  );
  return toggle;
}
