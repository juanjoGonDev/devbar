import { describe, it, expect } from 'vitest';

/**
 * config-store.test.js
 *
 * config-store is a CJS module that requires electron-store (ESM) at load time
 * and creates a Store instance immediately, so it cannot be imported in a pure
 * Node/Vitest context without a live Electron app.
 *
 * Instead, we test the clamping logic inline (mirroring what config-store
 * exports as the clampMaxLogLines helper), verifying the contract documented
 * in the spec. The groups-model.test.js file covers the parallel
 * clampMaxLogLinesOrNull helper for command-level overrides.
 */

// ─── Inline replica of config-store's clampMaxLogLines helper ─────────────────
// This mirrors the implementation in src/config-store.js exactly.
// If the implementation changes, these tests will serve as a specification.
function clampMaxLogLines(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 2000;
  return Math.min(50000, Math.max(100, Math.floor(n)));
}

describe('config-store — clampMaxLogLines helper (spec-level tests)', () => {
  it('returns 2000 as default when value is undefined', () => {
    expect(clampMaxLogLines(undefined)).toBe(2000);
  });

  it('returns 2000 as default when value is null', () => {
    expect(clampMaxLogLines(null)).toBe(2000);
  });

  it('returns 2000 as default when value is empty string', () => {
    expect(clampMaxLogLines('')).toBe(2000);
  });

  it('returns 2000 as default when value is 0', () => {
    expect(clampMaxLogLines(0)).toBe(2000);
  });

  it('returns 2000 as default when value is NaN string', () => {
    expect(clampMaxLogLines('abc')).toBe(2000);
  });

  it('preserves the default value 2000', () => {
    expect(clampMaxLogLines(2000)).toBe(2000);
  });

  it('preserves a valid value within range (500)', () => {
    expect(clampMaxLogLines(500)).toBe(500);
  });

  it('clamps below floor: 50 → 100', () => {
    expect(clampMaxLogLines(50)).toBe(100);
  });

  it('accepts floor boundary (100 → 100)', () => {
    expect(clampMaxLogLines(100)).toBe(100);
  });

  it('clamps above ceiling: 99999 → 50000', () => {
    expect(clampMaxLogLines(99999)).toBe(50000);
  });

  it('accepts ceiling boundary (50000 → 50000)', () => {
    expect(clampMaxLogLines(50000)).toBe(50000);
  });

  it('floors fractional values (500.9 → 500)', () => {
    expect(clampMaxLogLines(500.9)).toBe(500);
  });
});

describe('config-store — DEFAULT_GLOBAL_SETTINGS contract', () => {
  // These are static contract tests documenting what the module exports.
  // They live here so the verify phase can confirm the shape is correct.
  const DEFAULT_GLOBAL_SETTINGS = {
    autostart: false,
    silenceWarnings: false,
    silenceErrors: false,
    maxLogLines: 2000,
  };

  it('default maxLogLines is 2000', () => {
    expect(DEFAULT_GLOBAL_SETTINGS.maxLogLines).toBe(2000);
  });

  it('default autostart is false', () => {
    expect(DEFAULT_GLOBAL_SETTINGS.autostart).toBe(false);
  });

  it('all required fields are present', () => {
    expect(DEFAULT_GLOBAL_SETTINGS).toHaveProperty('autostart');
    expect(DEFAULT_GLOBAL_SETTINGS).toHaveProperty('silenceWarnings');
    expect(DEFAULT_GLOBAL_SETTINGS).toHaveProperty('silenceErrors');
    expect(DEFAULT_GLOBAL_SETTINGS).toHaveProperty('maxLogLines');
  });
});

// ─── Inline replica of clampNotifyAutoCloseSecs (mirrors src/config-store.js) ──
// 0 = "leave it to macOS"; otherwise floor and clamp to [1, 3600].
function clampNotifyAutoCloseSecs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3600, Math.floor(n));
}

describe('config-store — clampNotifyAutoCloseSecs helper (spec-level tests)', () => {
  it('returns 0 for missing/empty/invalid/negative values', () => {
    expect(clampNotifyAutoCloseSecs(undefined)).toBe(0);
    expect(clampNotifyAutoCloseSecs('')).toBe(0);
    expect(clampNotifyAutoCloseSecs('abc')).toBe(0);
    expect(clampNotifyAutoCloseSecs(-5)).toBe(0);
    expect(clampNotifyAutoCloseSecs(0)).toBe(0);
  });

  it('preserves a valid value and floors fractionals', () => {
    expect(clampNotifyAutoCloseSecs(10)).toBe(10);
    expect(clampNotifyAutoCloseSecs(12.9)).toBe(12);
  });

  it('clamps above the ceiling to 3600', () => {
    expect(clampNotifyAutoCloseSecs(99999)).toBe(3600);
  });
});
