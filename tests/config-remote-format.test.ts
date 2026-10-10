import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatDate,
  lastSeen,
} from '../renderer/config/remote-format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

describe('renderer/config/remote-format.ts', () => {
  describe('formatCountdown', () => {
    it('shows minutes and zero-padded seconds, rounding up', () => {
      expect(formatCountdown(5 * MINUTE)).toBe('5:00');
      expect(formatCountdown(61_001)).toBe('1:02');
      expect(formatCountdown(9_000)).toBe('0:09');
    });

    it('never goes below zero', () => {
      expect(formatCountdown(-5_000)).toBe('0:00');
    });
  });

  describe('formatDate', () => {
    it('writes a Spanish day, short month and year', () => {
      const text = formatDate(NOW);

      expect(text).toMatch(/^1 oct\.? 2026$/);
    });
  });

  describe('lastSeen', () => {
    it('reads the last minute as a moment ago', () => {
      expect(lastSeen(NOW - 30_000, NOW)).toBe('hace un momento');
    });

    it.each([
      [5 * MINUTE, 'hace 5 min'],
      [3 * HOUR, 'hace 3 h'],
      [DAY, 'hace 1 día'],
      [4 * DAY, 'hace 4 días'],
    ])('reads %i ms ago as "%s"', (age, label) => {
      expect(lastSeen(NOW - age, NOW)).toBe(label);
    });

    it('falls back to the date after a week', () => {
      expect(lastSeen(NOW - 10 * DAY, NOW)).toBe(formatDate(NOW - 10 * DAY));
    });
  });
});
