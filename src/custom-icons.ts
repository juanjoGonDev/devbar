/**
 * Images the user uploaded to use as icons (see CustomIcon). This module is
 * the one definition of what a stored custom icon may look like, shared by
 * the store (which drops malformed entries), the importer (which rejects
 * them) and the renderer (which resolves `img:<id>` references).
 *
 * Only inline PNG data URLs are ever accepted: main re-encodes every upload
 * to PNG, and an SVG upload is rasterized to PNG in the config renderer
 * before it reaches the store, so anything else — SVG above all, which can
 * carry script — can only come from a hand-edited or hostile file.
 */
import type { CustomIcon, Group } from './domain-types.js';

const REF_PREFIX = 'img:';

/** How many uploaded icons the library holds. */
export const MAX_CUSTOM_ICONS = 200;

/** Longest side, in pixels, an upload is scaled down to. */
export const CUSTOM_ICON_MAX_SIDE = 64;

/**
 * A 64 × 64 PNG is a few KB; even an incompressible one stays well under
 * this. The cap keeps a crafted import from bloating the config file.
 */
const MAX_DATA_URL_LENGTH = 100_000;

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
/** Base64 of the 8-byte PNG signature (and the first IHDR bytes). */
const PNG_SIGNATURE_BASE64 = 'iVBORw0KGgo';
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
const ICON_ID = /^[a-z0-9]{6,64}$/;
const MAX_NAME_LENGTH = 80;

export function customIconRef(id: string): string {
  return `${REF_PREFIX}${id}`;
}

/** The id an icon value points at, or null when it is not an image ref. */
export function customIconIdOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) return null;
  const id = value.slice(REF_PREFIX.length);
  return id ? id : null;
}

export function isPngDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_DATA_URL_LENGTH) return false;
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) return false;
  const body = value.slice(PNG_DATA_URL_PREFIX.length);
  return body.startsWith(PNG_SIGNATURE_BASE64) && BASE64_BODY.test(body);
}

/** The display name an icon is stored under: trimmed, capped, never empty. */
export function customIconName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name ? name.slice(0, MAX_NAME_LENGTH) : 'Imagen';
}

function normalizeCustomIcon(value: unknown): CustomIcon | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ICON_ID.test(raw.id)) return null;
  if (!isPngDataUrl(raw.dataUrl)) return null;
  return { id: raw.id, name: customIconName(raw.name), dataUrl: raw.dataUrl };
}

/** The first valid icon per id, at most MAX_CUSTOM_ICONS. Total. */
export function normalizeCustomIcons(value: unknown): CustomIcon[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const icons: CustomIcon[] = [];
  for (const candidate of value) {
    const icon = normalizeCustomIcon(candidate);
    if (!icon || seen.has(icon.id)) continue;
    seen.add(icon.id);
    icons.push(icon);
    if (icons.length === MAX_CUSTOM_ICONS) break;
  }
  return icons;
}

/** Strict counterpart for imports: one bad entry rejects the file. */
export function validateCustomIcons(
  value: unknown,
): { ok: true; icons: CustomIcon[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, icons: [] };
  if (!Array.isArray(value))
    return { ok: false, error: 'customIcons debe ser un array' };
  if (value.length > MAX_CUSTOM_ICONS)
    return {
      ok: false,
      error: `Demasiados iconos personalizados (máximo ${MAX_CUSTOM_ICONS})`,
    };
  for (let index = 0; index < value.length; index++) {
    if (!normalizeCustomIcon(value[index]))
      return { ok: false, error: `Icono personalizado #${index} inválido` };
  }
  return { ok: true, icons: normalizeCustomIcons(value) };
}

/** Every custom icon id a group, command or action points at. */
export function referencedCustomIconIds(groups: readonly Group[]): Set<string> {
  const ids = new Set<string>();
  const add = (value: string | null): void => {
    const id = customIconIdOf(value);
    if (id) ids.add(id);
  };
  for (const group of groups) {
    add(group.icon);
    for (const command of group.commands) add(command.icon);
    for (const action of group.actions) add(action.icon);
  }
  return ids;
}

/** `existing` first (it wins an id clash), then what `incoming` adds. */
export function mergeCustomIcons(
  existing: readonly CustomIcon[],
  incoming: readonly CustomIcon[],
): CustomIcon[] {
  return normalizeCustomIcons([...existing, ...incoming]);
}
