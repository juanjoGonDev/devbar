import { describe, it, expect } from 'vitest';
import { formatUptime } from '../src/format-uptime.js';

describe('formatUptime', () => {
  // ── seconds range ────────────────────────────────────────────────────
  it('returns "0s" for 0 ms', () => {
    expect(formatUptime(0)).toBe('0s');
  });

  it('returns "1s" for 1000 ms', () => {
    expect(formatUptime(1000)).toBe('1s');
  });

  it('returns "59s" for 59 000 ms', () => {
    expect(formatUptime(59_000)).toBe('59s');
  });

  // ── minutes range ────────────────────────────────────────────────────
  it('returns "1m 0s" at exactly 60 000 ms', () => {
    expect(formatUptime(60_000)).toBe('1m 0s');
  });

  it('returns "3m 12s" for 3 min 12 sec', () => {
    expect(formatUptime(3 * 60_000 + 12_000)).toBe('3m 12s');
  });

  it('returns "59m 59s" just below one hour', () => {
    expect(formatUptime(59 * 60_000 + 59_000)).toBe('59m 59s');
  });

  // ── hours range ──────────────────────────────────────────────────────
  it('returns "1h 0m" at exactly one hour', () => {
    expect(formatUptime(3_600_000)).toBe('1h 0m');
  });

  it('returns "2h 47m" for 2 hours 47 minutes', () => {
    expect(formatUptime(2 * 3_600_000 + 47 * 60_000)).toBe('2h 47m');
  });

  it('returns "23h 59m" just below one day', () => {
    expect(formatUptime(23 * 3_600_000 + 59 * 60_000)).toBe('23h 59m');
  });

  // ── days range ───────────────────────────────────────────────────────
  it('returns "1d 0h" at exactly one day', () => {
    expect(formatUptime(86_400_000)).toBe('1d 0h');
  });

  it('returns "1d 4h" for 1 day 4 hours', () => {
    expect(formatUptime(86_400_000 + 4 * 3_600_000)).toBe('1d 4h');
  });

  // ── edge / invalid inputs ────────────────────────────────────────────
  it('treats negative ms as 0', () => {
    expect(formatUptime(-5000)).toBe('0s');
  });

  it('treats NaN as 0', () => {
    expect(formatUptime(NaN)).toBe('0s');
  });

  it('treats non-number as 0', () => {
    expect(formatUptime(null)).toBe('0s');
    expect(formatUptime(undefined)).toBe('0s');
  });
});
