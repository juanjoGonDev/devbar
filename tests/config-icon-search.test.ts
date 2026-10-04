import { describe, expect, it } from 'vitest';
import {
  buildIconSearchIndex,
  normalizeSearchText,
  searchIconIndex,
} from '../renderer/config/icon-search.js';
import type { IconBatteryItem } from '../src/ipc-contract.js';

const BATTERY: IconBatteryItem[] = [
  {
    name: 'shopping-cart',
    tags: ['trolley'],
    es: ['compras', 'carrito', 'carro'],
    esName: 'compras carrito',
  },
  {
    name: 'house',
    tags: ['home', 'living'],
    es: ['casa', 'hogar'],
    esName: 'casa',
  },
  {
    name: 'cart-plus',
    tags: [],
    es: ['carrito', 'más'],
    esName: 'carrito más',
  },
  {
    name: 'lock',
    tags: ['security', 'password'],
    es: ['candado', 'seguridad', 'contraseña'],
    esName: 'candado',
  },
  { name: 'dog', tags: ['pet', 'animal'] },
];

const names = (query: string): string[] =>
  searchIconIndex(buildIconSearchIndex(BATTERY), query).map((i) => i.name);

describe('renderer/config/icon-search.ts', () => {
  it('folds case, accents and separators', () => {
    expect(normalizeSearchText('  Contraseña_Única--Ya ')).toBe(
      'contrasena unica ya',
    );
  });

  it('matches English names and tags', () => {
    expect(names('house')).toEqual(['house']);
    expect(names('home')).toEqual(['house']);
    expect(names('pet')).toEqual(['dog']);
  });

  it('matches Spanish, ignoring accents either way', () => {
    expect(names('casa')).toEqual(['house']);
    expect(names('contrasena')).toEqual(['lock']);
    expect(names('CONTRASEÑA')).toEqual(['lock']);
    expect(names('mas')).toEqual(['cart-plus']);
  });

  it('ranks name matches (in either language) before tag matches', () => {
    // "carrito" is in the Spanish NAME of both carts; "carro" only in a term.
    expect(names('carrito')).toEqual(['shopping-cart', 'cart-plus']);
    expect(names('seguridad')).toEqual(['lock']);
    expect(names('cart')).toEqual(['shopping-cart', 'cart-plus']);
  });

  it('keeps spaces and dashes interchangeable', () => {
    expect(names('shopping cart')).toEqual(['shopping-cart']);
    expect(names('shopping-cart')).toEqual(['shopping-cart']);
  });

  it('finds nothing for a blank query', () => {
    expect(names('   ')).toEqual([]);
  });
});
