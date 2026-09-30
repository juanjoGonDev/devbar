import { describe, expect, it } from 'vitest';
import {
  customIconIdOf,
  customIconRef,
  MAX_CUSTOM_ICONS,
  mergeCustomIcons,
  normalizeCustomIcons,
  referencedCustomIconIds,
  validateCustomIcons,
} from '../src/custom-icons.js';
import { normalizeGroup } from '../src/groups/normalize.js';

/** A real 1×1 PNG. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const icon = (id: string, name = id) => ({ id, name, dataUrl: PNG });

describe('src/custom-icons.ts', () => {
  it('references an uploaded icon as img:<id> and reads the id back', () => {
    expect(customIconRef('abc123def456')).toBe('img:abc123def456');
    expect(customIconIdOf('img:abc123def456')).toBe('abc123def456');
    expect(customIconIdOf('rocket')).toBeNull();
    expect(customIconIdOf('img:')).toBeNull();
    expect(customIconIdOf(null)).toBeNull();
  });

  describe('normalizeCustomIcons', () => {
    it('keeps well-formed PNG icons and names them', () => {
      expect(
        normalizeCustomIcons([
          { id: 'abc123', name: '  Logo  ', dataUrl: PNG },
        ]),
      ).toEqual([{ id: 'abc123', name: 'Logo', dataUrl: PNG }]);
      expect(
        normalizeCustomIcons([{ id: 'abc123', dataUrl: PNG }])[0]?.name,
      ).toBe('Imagen');
    });

    it('drops anything that is not an inline PNG with a sane id', () => {
      expect(
        normalizeCustomIcons([
          {
            id: 'abc123',
            name: 'svg',
            dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
          },
          {
            id: 'abc124',
            name: 'jpeg',
            dataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
          },
          { id: 'abc125', name: 'fake', dataUrl: 'data:image/png;base64,AAAA' },
          { id: 'abc126', name: 'junk', dataUrl: `${PNG}<script>` },
          { id: 'BAD ID', name: 'id', dataUrl: PNG },
          { id: 'abc127', name: 'huge', dataUrl: PNG + 'A'.repeat(200_000) },
          'not an object',
        ]),
      ).toEqual([]);
      expect(normalizeCustomIcons('nope')).toEqual([]);
    });

    it('dedupes by id and caps the library', () => {
      expect(
        normalizeCustomIcons([icon('abc123', 'a'), icon('abc123', 'b')]),
      ).toEqual([icon('abc123', 'a')]);
      const many = Array.from({ length: MAX_CUSTOM_ICONS + 5 }, (_, i) =>
        icon(`id${String(i).padStart(6, '0')}`),
      );
      expect(normalizeCustomIcons(many)).toHaveLength(MAX_CUSTOM_ICONS);
    });
  });

  describe('validateCustomIcons (imports)', () => {
    it('accepts an absent list as empty', () => {
      expect(validateCustomIcons(undefined)).toEqual({ ok: true, icons: [] });
    });

    it('accepts valid icons', () => {
      expect(validateCustomIcons([icon('abc123')])).toEqual({
        ok: true,
        icons: [icon('abc123')],
      });
    });

    it('rejects a non-array, an invalid entry and an oversized library', () => {
      expect(validateCustomIcons({}).ok).toBe(false);
      const bad = validateCustomIcons([
        icon('abc123'),
        { id: 'x', dataUrl: 'data:,' },
      ]);
      expect(bad).toEqual({
        ok: false,
        error: 'Icono personalizado #1 inválido',
      });
      const many = Array.from({ length: MAX_CUSTOM_ICONS + 1 }, (_, i) =>
        icon(`id${String(i).padStart(6, '0')}`),
      );
      expect(validateCustomIcons(many).ok).toBe(false);
    });
  });

  it('collects the ids every group, command and action points at', () => {
    const groups = [
      normalizeGroup({
        icon: 'img:aaa111',
        commands: [{ icon: 'img:bbb222' }, { icon: 'rocket' }],
        actions: [{ icon: 'img:ccc333' }, { icon: null }],
      }),
      normalizeGroup({ icon: 'package' }),
    ];
    expect([...referencedCustomIconIds(groups)].sort()).toEqual([
      'aaa111',
      'bbb222',
      'ccc333',
    ]);
  });

  it('merges two libraries, keeping existing icons first and capping', () => {
    expect(
      mergeCustomIcons(
        [icon('abc123', 'old')],
        [icon('abc123', 'new'), icon('def456')],
      ),
    ).toEqual([icon('abc123', 'old'), icon('def456')]);
  });
});
