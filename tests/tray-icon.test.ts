import { afterEach, describe, expect, it, vi } from 'vitest';

// tray-icon imports electron for nativeImage/nativeTheme. The mock records
// every bitmap so the count-badge rendering is observable without Electron.
const state = vi.hoisted(() => ({ dark: false }));
const created: { bitmap: Buffer; width: number; height: number }[] = [];

vi.mock('electron', () => ({
  nativeImage: {
    createFromBitmap: (
      bitmap: Buffer,
      opts: { width: number; height: number },
    ) => {
      const image = {
        bitmap,
        reps: [] as { scaleFactor: number; buffer: Buffer }[],
        template: true,
        addRepresentation(rep: { scaleFactor: number; buffer: Buffer }) {
          image.reps.push(rep);
        },
        setTemplateImage(v: boolean) {
          image.template = v;
        },
      };
      created.push({ bitmap, width: opts.width, height: opts.height });
      return image;
    },
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return state.dark;
    },
  },
}));

import {
  aggregateColor,
  badgeCount,
  invalidateCache,
  loadIcon,
  parseTrayCount,
} from '../src/tray-icon.js';

interface MockImage {
  bitmap: Buffer;
  reps: { scaleFactor: number; buffer: Buffer }[];
  template: boolean;
}

afterEach(() => {
  created.length = 0;
  state.dark = false;
  invalidateCache();
});

describe('badgeCount', () => {
  it('shows the error count when there are errors', () => {
    expect(badgeCount(3, 5)).toBe(3);
    expect(badgeCount(1, 0)).toBe(1);
  });

  it('falls back to the warning count when there are no errors', () => {
    expect(badgeCount(0, 4)).toBe(4);
  });

  it('is zero when there is nothing to report', () => {
    expect(badgeCount(0, 0)).toBe(0);
  });
});

describe('loadIcon with a count badge', () => {
  it('draws the count into the bitmap (differs from the no-count icon)', () => {
    const plain = loadIcon('error') as unknown as MockImage;
    const counted = loadIcon('error', false, 14) as unknown as MockImage;
    expect(counted.bitmap).not.toEqual(plain.bitmap);
    // The 2x representation carries the same badge.
    expect(counted.reps[0]?.buffer).not.toEqual(plain.reps[0]?.buffer);
  });

  it('caches per (state, theme, update, count) — same count hits the cache', () => {
    const a = loadIcon('error', false, 7);
    const b = loadIcon('error', false, 7);
    const c = loadIcon('error', false, 8);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    // A cache hit must not redraw: two distinct keys, two bitmaps.
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ width: 18, height: 18 });
  });

  it('re-renders when the OS appearance flips (theme is part of the key)', () => {
    // Regression: dropping the theme from the cache key left the light
    // icon on screen after a light→dark switch — the outline colour that
    // keeps the mark visible on the new menubar background never changed.
    const light = loadIcon('running') as unknown as MockImage;
    state.dark = true;
    const dark = loadIcon('running') as unknown as MockImage;
    expect(dark).not.toBe(light);
    expect(dark.bitmap).not.toEqual(light.bitmap);
  });

  it('keeps 99 ("99") and 100 ("99+") as distinct cache entries', () => {
    // Regression: the key used Math.min(count, 99), so 99 and 100
    // collided and whichever was rendered first kept the wrong label.
    const n99 = loadIcon('error', false, 99) as unknown as MockImage;
    const n100 = loadIcon('error', false, 100) as unknown as MockImage;
    const n101 = loadIcon('error', false, 101);
    expect(n100.bitmap).not.toEqual(n99.bitmap);
    // 100 and 101 both render "99+" — they DO share the cache.
    expect(n101).toBe(n100);
  });

  it('keeps the pending-update dot when there is no count', () => {
    const none = loadIcon('stopped') as unknown as MockImage;
    const update = loadIcon('stopped', true) as unknown as MockImage;
    const updatePlusCount = loadIcon(
      'stopped',
      true,
      3,
    ) as unknown as MockImage;
    expect(update.bitmap).not.toEqual(none.bitmap);
    expect(updatePlusCount.bitmap).not.toEqual(update.bitmap);
  });
});

describe('parseTrayCount', () => {
  it('accepts non-negative integers (numbers and numeric strings)', () => {
    expect(parseTrayCount(0)).toBe(0);
    expect(parseTrayCount(14)).toBe(14);
    expect(parseTrayCount('14')).toBe(14);
  });

  it('caps huge values at 9999', () => {
    expect(parseTrayCount(9999)).toBe(9999);
    expect(parseTrayCount(123456)).toBe(9999);
  });

  it('rejects invalid input (release the override)', () => {
    expect(parseTrayCount(null)).toBeNull();
    expect(parseTrayCount(undefined)).toBeNull();
    expect(parseTrayCount('')).toBeNull();
    expect(parseTrayCount('  ')).toBeNull();
    expect(parseTrayCount(-1)).toBeNull();
    expect(parseTrayCount(1.5)).toBeNull();
    expect(parseTrayCount('abc')).toBeNull();
    expect(parseTrayCount({ count: 5 })).toBeNull();
    expect(parseTrayCount(true)).toBeNull();
  });
});

describe('aggregateColor', () => {
  it('returns the worst state across groups', () => {
    expect(aggregateColor([{ color: 'running' }, { color: 'error' }])).toBe(
      'error',
    );
    expect(aggregateColor([{ color: 'stopped' }])).toBe('stopped');
    expect(aggregateColor([{ color: 'warn' }, { color: 'running' }])).toBe(
      'warn',
    );
    expect(aggregateColor([{ color: null }])).toBe('stopped');
  });
});
