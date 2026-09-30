import type { IconBatteryItem } from '../../src/ipc-contract.js';

/**
 * Icon search over the battery, in English (Lucide's own names and tags) and
 * Spanish (the terms main adds from src/icon-search-es.ts). Case, accents
 * and separators never matter: "contrasena" finds "contraseña", and
 * "shopping cart" finds "shopping-cart".
 */

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

interface IndexedIcon {
  item: IconBatteryItem;
  /** English and Spanish name, normalized. */
  names: string;
  /** Tags and Spanish terms, normalized. */
  terms: string;
}

export type IconSearchIndex = readonly IndexedIcon[];

/** Separator no normalized query can contain, so a match never spans two
 *  terms. */
const SEP = '\u0000';

/** Normalizes every searchable string once, not on every keystroke. */
export function buildIconSearchIndex(
  items: readonly IconBatteryItem[],
): IconSearchIndex {
  return items.map((item) => ({
    item,
    names: [item.name, item.esName ?? ''].map(normalizeSearchText).join(SEP),
    terms: [...item.tags, ...(item.es ?? [])]
      .map(normalizeSearchText)
      .join(SEP),
  }));
}

/** Name matches first, then tag/translation matches, each in battery order. */
export function searchIconIndex(
  index: IconSearchIndex,
  query: string,
): IconBatteryItem[] {
  const q = normalizeSearchText(query);
  if (!q) return [];
  const byName: IconBatteryItem[] = [];
  const byTerm: IconBatteryItem[] = [];
  for (const entry of index) {
    if (entry.names.includes(q)) byName.push(entry.item);
    else if (entry.terms.includes(q)) byTerm.push(entry.item);
  }
  return [...byName, ...byTerm];
}
