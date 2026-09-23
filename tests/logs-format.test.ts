import { describe, expect, it } from 'vitest';

import { fmtTime, mutedKey, sourceColor } from '../renderer/logs/format.js';

describe('renderer/logs/format.ts', () => {
  describe('fmtTime', () => {
    it('pads every field so the column never jitters', () => {
      // Local time on purpose: the stamp is read next to a wall clock.
      const ts = new Date(2024, 0, 2, 3, 4, 5, 6).getTime();
      expect(fmtTime(ts)).toBe('03:04:05.006');
    });

    it('keeps three digits of milliseconds', () => {
      const ts = new Date(2024, 0, 2, 23, 59, 59, 999).getTime();
      expect(fmtTime(ts)).toBe('23:59:59.999');
    });
  });

  describe('sourceColor', () => {
    it('gives one name the same hue every time', () => {
      expect(sourceColor('api')).toBe(sourceColor('api'));
    });

    it('gives different names different hues', () => {
      expect(sourceColor('api')).not.toBe(sourceColor('web'));
    });

    it('stays inside the hue circle even for a long name', () => {
      const hue = Number(
        /hsl\((\d+)/u.exec(
          sourceColor('un-servicio-con-nombre-larguísimo'),
        )?.[1],
      );
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    });

    it('answers for the empty name instead of producing NaN', () => {
      expect(sourceColor('')).toBe('hsl(0 70% 68%)');
    });
  });

  describe('mutedKey', () => {
    it('collapses two sightings of the same event onto one key', () => {
      expect(mutedKey('reintento 12 tras 300ms')).toBe(
        mutedKey('reintento 7 tras 900ms'),
      );
    });

    it('keeps genuinely different events apart', () => {
      expect(mutedKey('conexión perdida')).not.toBe(mutedKey('disco lleno'));
    });

    it('collapses a UUID, which changes every run', () => {
      expect(mutedKey('job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 falló')).toBe(
        mutedKey('job 9c858901-8a57-4791-81fe-4c455b099bc9 falló'),
      );
    });

    it('collapses a hex address', () => {
      expect(mutedKey('segfault at 0xdeadbeef')).toBe(
        mutedKey('segfault at 0xcafebabe'),
      );
    });

    it('ignores the colour a line happened to arrive in', () => {
      expect(mutedKey('[31mfallo[0m')).toBe(mutedKey('fallo'));
    });

    it('caps the key so one enormous line cannot dominate the feed', () => {
      expect(mutedKey('x'.repeat(500))).toHaveLength(200);
    });
  });
});
