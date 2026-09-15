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
} from '../src/tray-icon.js';

interface MockImage {
  bitmap: Buffer;
  reps: { scaleFactor: number; buffer: Buffer }[];
  template: boolean;
}

afterEach(() => {
  created.length = 0;
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
