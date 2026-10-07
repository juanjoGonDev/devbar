/**
 * The one place the UI creates a glyph. Every icon is a Lucide glyph from the
 * bundled font (assets/fonts/lucide.woff2, declared in icons.css), so it
 * renders identically on every OS — no system emoji font involved.
 *
 * Icons are decorative (`aria-hidden`): the control around one carries the
 * accessible name, through its own text, `title` or `aria-label`.
 */
import { ICON_CODEPOINTS } from './icon-codepoints.js';
import { customIconIdOf } from '../src/custom-icons.js';
import { normalizeIconColor } from '../src/icon-color.js';
import type { CustomIcon } from '../src/domain-types.js';

/** The icons the chrome itself uses — a typo here fails typecheck. */
export type IconName =
  | 'app-window'
  | 'arrow-down'
  | 'arrow-right'
  | 'ban'
  | 'bell'
  | 'bell-off'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'circle-x'
  | 'clock'
  | 'copy'
  | 'dna'
  | 'ellipsis'
  | 'external-link'
  | 'fast-forward'
  | 'flask-conical'
  | 'folder'
  | 'folder-open'
  | 'grip-vertical'
  | 'history'
  | 'image'
  | 'info'
  | 'layout-grid'
  | 'package'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'pencil'
  | 'play'
  | 'plus'
  | 'power'
  | 'puzzle'
  | 'save'
  | 'scroll-text'
  | 'settings'
  | 'shield'
  | 'shield-check'
  | 'smartphone'
  | 'split'
  | 'square'
  | 'terminal'
  | 'timer'
  | 'trash-2'
  | 'triangle-alert'
  | 'unlink'
  | 'upload'
  | 'wand-sparkles'
  | 'x'
  | 'zap';

/** True for a name the bundled font draws (own keys only). */
export function isIconName(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(ICON_CODEPOINTS, value);
}

function glyphSpan(name: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'icon';
  el.dataset.icon = name;
  el.setAttribute('aria-hidden', 'true');
  el.textContent = String.fromCodePoint(ICON_CODEPOINTS[name] ?? 0);
  return el;
}

export function icon(name: IconName): HTMLSpanElement {
  return glyphSpan(name);
}

/** An icon-only button: the label becomes its tooltip and accessible name. */
export function iconButton(
  name: IconName,
  label: string,
  className: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(glyphSpan(name));
  return btn;
}

/**
 * The uploaded images `img:<id>` refers to, per window. Each window loads the
 * library and keeps it current through renderer/custom-icons.ts; the version
 * lets a painter that caches its output (the logs sidebar) notice a change.
 */
const customIcons = new Map<string, CustomIcon>();
let customIconsRevision = 0;

export function setCustomIcons(icons: readonly CustomIcon[]): void {
  customIcons.clear();
  for (const item of icons) customIcons.set(item.id, item);
  customIconsRevision++;
}

export function customIconList(): CustomIcon[] {
  return [...customIcons.values()];
}

export function customIconsVersion(): number {
  return customIconsRevision;
}

function imageSpan(value: string, dataUrl: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'icon icon-img';
  el.dataset.icon = value;
  el.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  img.draggable = false;
  el.append(img);
  return el;
}

function paintUserIcon(
  value: string | null | undefined,
  fallback: IconName,
  color: string | null | undefined,
): HTMLSpanElement {
  const imageId = customIconIdOf(value);
  if (value && imageId !== null) {
    const found = customIcons.get(imageId);
    if (found) return imageSpan(value, found.dataUrl);
  }
  let el: HTMLSpanElement;
  if (isIconName(value)) el = glyphSpan(value);
  else if (!value || imageId !== null) el = glyphSpan(fallback);
  else {
    el = document.createElement('span');
    el.className = 'icon icon-text';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = value;
  }
  const tint = normalizeIconColor(color);
  if (tint) el.style.color = tint;
  return el;
}

/**
 * A user-chosen icon (Group/Command/Action.icon). A Lucide name paints its
 * glyph, in `color` when one is set; `img:<id>` paints that uploaded image
 * (colour does not apply); nothing stored, or an image that no longer
 * exists, paints `fallback`. Anything else — a raw emoji the migration had
 * no mapping for, a hand-edited config — is shown as the text it is, so an
 * odd value degrades to itself instead of vanishing.
 *
 * An image reference remembers what it was asked for, so
 * `repaintCustomIcons` can swap it in place when the library changes.
 */
export function userIcon(
  value: string | null | undefined,
  fallback: IconName,
  color?: string | null,
): HTMLSpanElement {
  const el = paintUserIcon(value, fallback, color);
  if (value && customIconIdOf(value) !== null) {
    el.dataset.customIcon = value;
    el.dataset.fallback = fallback;
    if (color) el.dataset.color = color;
  }
  return el;
}

/** Re-paints every image reference under `root` against the current
 *  library: a fresh upload appears, a deleted one falls back. */
export function repaintCustomIcons(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-custom-icon]')) {
    const { customIcon, fallback, color } = el.dataset;
    // Only ever written by userIcon above, from an IconName.
    el.replaceWith(userIcon(customIcon, fallback as IconName, color ?? null));
  }
}

/** Paints the `<span class="icon" data-icon="…">` placeholders of static
 *  window markup. An unknown name stays empty rather than guessing. */
export function hydrateIcons(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('.icon[data-icon]')) {
    const name = el.dataset.icon;
    el.setAttribute('aria-hidden', 'true');
    el.textContent = isIconName(name)
      ? String.fromCodePoint(ICON_CODEPOINTS[name] ?? 0)
      : '';
  }
}
