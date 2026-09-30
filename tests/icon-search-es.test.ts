import { describe, expect, it } from 'vitest';
import { ICON_BATTERY } from '../src/icon-battery.js';
import {
  ICON_SEARCH_ES,
  ICON_SEARCH_ES_UNTRANSLATED,
} from '../src/icon-search-es.js';
import { spanishTerms, withSpanishSearch } from '../src/icon-search.js';

/**
 * The Spanish dictionary is hand-authored, so it is not under the
 * generator's drift test — but every word of every icon NAME must be either
 * translated or explicitly marked as needing no translation. A Lucide bump
 * that brings new words fails here until someone handles them.
 */

const nameWords = new Set(ICON_BATTERY.flatMap((icon) => icon.name.split('-')));
const untranslated = new Set(ICON_SEARCH_ES_UNTRANSLATED);

describe('src/icon-search-es.ts', () => {
  it('translates or allowlists every word in the icon names', () => {
    const missing = [...nameWords].filter(
      (word) => !Object.hasOwn(ICON_SEARCH_ES, word) && !untranslated.has(word),
    );
    expect(missing).toEqual([]);
  });

  it('never both translates a word and calls it untranslatable', () => {
    expect(
      ICON_SEARCH_ES_UNTRANSLATED.filter((word) =>
        Object.hasOwn(ICON_SEARCH_ES, word),
      ),
    ).toEqual([]);
  });

  it('keeps no stale allowlist entry', () => {
    expect(
      ICON_SEARCH_ES_UNTRANSLATED.filter((word) => !nameWords.has(word)),
    ).toEqual([]);
  });

  it('holds real translations: non-empty, lowercase, not the word itself', () => {
    for (const [word, value] of Object.entries(ICON_SEARCH_ES)) {
      const terms = value.split('|');
      expect(
        terms.every((t) => t.trim() === t && t.length > 0),
        word,
      ).toBe(true);
      expect(terms, word).not.toContain(word);
      expect(value, word).toBe(value.toLowerCase());
    }
  });

  it('is a large vocabulary, not a token sample', () => {
    expect(Object.keys(ICON_SEARCH_ES).length).toBeGreaterThan(1800);
  });
});

describe('src/icon-search.ts', () => {
  it('translates a name word by word, and gathers name and tag terms', () => {
    const cart = spanishTerms({
      name: 'shopping-cart',
      tags: ['trolley', 'e-commerce'],
    });
    expect(cart.esName).toBe('compras carrito');
    expect(cart.es).toEqual(
      expect.arrayContaining(['compras', 'carrito', 'carro', 'comercio']),
    );
    expect(new Set(cart.es).size).toBe(cart.es.length);
  });

  it('keeps untranslated words as they are in the Spanish name', () => {
    expect(spanishTerms({ name: 'git-branch', tags: [] }).esName).toBe(
      'git rama',
    );
  });

  it('gives no Spanish name when no word of the name translates', () => {
    const wifi = spanishTerms({ name: 'wifi', tags: [] });
    expect(wifi.esName).toBeUndefined();
    expect(wifi.es).toEqual([]);
  });

  it('never trips over Object.prototype members', () => {
    expect(
      spanishTerms({ name: 'constructor', tags: ['toString'] }).es,
    ).toEqual([]);
  });

  it('decorates the whole battery for the picker', () => {
    const battery = withSpanishSearch(ICON_BATTERY);
    expect(battery).toHaveLength(ICON_BATTERY.length);
    const lock = battery.find((icon) => icon.name === 'lock');
    expect(lock?.esName).toBe('candado');
    expect(lock?.es).toEqual(expect.arrayContaining(['candado', 'seguridad']));
    const rocket = battery.find((icon) => icon.name === 'rocket');
    expect(rocket?.es).toContain('cohete');
  });
});
