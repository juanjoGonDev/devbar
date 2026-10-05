/**
 * The phone page's icons: a handful of Lucide outlines (ISC licence, the
 * same set the app's own icon font comes from) built as SVG with DOM calls.
 * The page has no icon font and no markup is ever parsed, so this table of
 * path data is the whole icon system.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A circle as path data, so every glyph is just a list of paths. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
  play: [
    'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z',
  ],
  stop: [
    'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  ],
  logs: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
  chevron: ['m9 18 6-6-6-6'],
  branch: [
    'M6 3v12',
    circle(18, 6, 3),
    circle(6, 18, 3),
    'M18 9a9 9 0 0 1-9 9',
  ],
  restart: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  bell: [
    'M10.268 21a2 2 0 0 0 3.464 0',
    'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
  ],
  groups: [
    'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z',
    'M12 22V12',
    'm3.3 7 8.7 5 8.7-5',
  ],
  settings: ['M20 7h-9', 'M14 17H5', circle(17, 17, 3), circle(7, 7, 3)],
  help: [
    circle(12, 12, 10),
    'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3',
    'M12 17h.01',
  ],
  download: [
    'M12 15V3',
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
    'm7 10 5 5 5-5',
  ],
  alert: [circle(12, 12, 10), 'M12 8v4', 'M12 16h.01'],
  check: ['M20 6 9 17l-5-5'],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  info: [circle(12, 12, 10), 'M12 16v-4', 'M12 8h.01'],
  lock: [
    'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
    'M7 11V7a5 5 0 0 1 10 0v4',
  ],
  shieldCheck: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'm9 12 2 2 4-4',
  ],
  shieldAlert: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'M12 8v4',
    'M12 16h.01',
  ],
  key: [
    'm2 21 9.6-9.6',
    'm7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19',
    circle(15.5, 7.5, 5.5),
  ],
} as const;

export type GlyphName = keyof typeof PATHS;

const isGlyph = (name: string): name is GlyphName => name in PATHS;

/** A decorative icon: labelled by its button, hidden from screen readers. */
export function glyph(name: GlyphName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'i');
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Fills every `[data-glyph]` placeholder of the static markup. */
export function fillGlyphs(root: ParentNode): void {
  for (const slot of root.querySelectorAll<HTMLElement>('[data-glyph]')) {
    const name = slot.dataset.glyph ?? '';
    if (isGlyph(name)) slot.replaceChildren(glyph(name));
  }
}
