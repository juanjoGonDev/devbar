import { describe, expect, it } from 'vitest';
import { ICON_COLOR_PRESETS, normalizeIconColor } from '../src/icon-color.js';

describe('src/icon-color.ts', () => {
  it('accepts #rrggbb in any case and stores it lowercase', () => {
    expect(normalizeIconColor('#22C55E')).toBe('#22c55e');
    expect(normalizeIconColor('  #aabbcc ')).toBe('#aabbcc');
  });

  it('turns anything else into null (inherit the text colour)', () => {
    for (const value of [
      null,
      undefined,
      '',
      'red',
      '#abc',
      '#aabbccdd',
      'aabbcc',
      '#gggggg',
      42,
      {},
    ])
      expect(normalizeIconColor(value)).toBeNull();
  });

  it('offers ten distinct, valid presets with Spanish labels', () => {
    expect(ICON_COLOR_PRESETS).toHaveLength(10);
    const values = ICON_COLOR_PRESETS.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
    for (const preset of ICON_COLOR_PRESETS) {
      expect(normalizeIconColor(preset.value)).toBe(preset.value);
      expect(preset.label).toMatch(/^[A-ZÁÉÍÓÚ][a-záéíóúñ]+$/);
    }
  });
});
