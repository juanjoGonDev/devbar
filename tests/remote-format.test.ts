import { describe, expect, it } from 'vitest';
import {
  clockTime,
  countdown,
  dayLabel,
  hourMinute,
  plural,
  shortDate,
  uptime,
} from '../renderer/remote/format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Wed 1 Oct 2026, 10:12:40 local time. */
const NOW = new Date(2026, 9, 1, 10, 12, 40).getTime();

describe('renderer/remote/format.ts', () => {
  describe('uptime', () => {
    it.each([
      [20_000, 'ahora'],
      [34 * MINUTE, '34m'],
      [HOUR + 12 * MINUTE, '1h 12m'],
      [2 * DAY + 3 * HOUR, '2d 3h'],
    ])('reads %i ms as "%s"', (ms, label) => {
      expect(uptime(ms)).toBe(label);
    });
  });

  describe('countdown', () => {
    it('rounds up to whole seconds and never goes below zero', () => {
      expect(countdown(41_200)).toBe(42);
      expect(countdown(-5)).toBe(0);
    });
  });

  describe('clockTime / hourMinute', () => {
    it('writes a log time and a notice time', () => {
      expect(clockTime(NOW)).toBe('10:12:40');
      expect(hourMinute(NOW)).toBe('10:12');
    });
  });

  describe('dayLabel', () => {
    it('says Hoy, Ayer, or the date', () => {
      expect(dayLabel(NOW - HOUR, NOW)).toBe('Hoy');
      expect(dayLabel(NOW - DAY, NOW)).toBe('Ayer');
      expect(dayLabel(NOW - 3 * DAY, NOW)).toBe(shortDate(NOW - 3 * DAY));
    });
  });

  describe('shortDate', () => {
    it('writes a Spanish day, short month and year', () => {
      expect(shortDate(NOW)).toMatch(/^1 oct\.? 2026$/);
    });
  });

  describe('plural', () => {
    it('picks the form for the count', () => {
      expect(plural(1, 'error', 'errores')).toBe('1 error');
      expect(plural(3, 'error', 'errores')).toBe('3 errores');
    });
  });
});
