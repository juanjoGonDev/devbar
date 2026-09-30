import type { IconBatteryItem } from './ipc-contract.js';
import { ICON_SEARCH_ES } from './icon-search-es.js';

/**
 * Adds Spanish search terms to the icon battery (see src/icon-search-es.ts):
 * `es` gathers the translation of every word in the icon's name and tags,
 * and `esName` renders the name word by word for the picker's tooltip. Done
 * once in main, so the renderer only ever matches strings.
 */

function translate(word: string): string[] {
  const key = word.toLowerCase();
  return Object.hasOwn(ICON_SEARCH_ES, key)
    ? (ICON_SEARCH_ES[key] ?? '').split('|')
    : [];
}

export function spanishTerms(item: { name: string; tags: readonly string[] }): {
  es: string[];
  esName?: string;
} {
  const nameWords = item.name.split('-');
  const tagWords = item.tags.flatMap((tag) => tag.split(/[\s-]+/));
  const es = [
    ...new Set([...nameWords, ...tagWords].flatMap((word) => translate(word))),
  ];
  const translatedName = nameWords.map((word) => translate(word)[0] ?? word);
  const translatedAny = nameWords.some((word) => translate(word).length > 0);
  return translatedAny ? { es, esName: translatedName.join(' ') } : { es };
}

export function withSpanishSearch(
  battery: readonly IconBatteryItem[],
): IconBatteryItem[] {
  return battery.map((item) => ({ ...item, ...spanishTerms(item) }));
}
