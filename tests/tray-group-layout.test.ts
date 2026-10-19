import { describe, expect, it } from 'vitest';

import { trayGroupLayout } from '../src/tray-group-layout.js';

/**
 * The one rule both the tray and a linked phone follow for groups hidden from
 * the tray: listed after the rest behind a fold, or not listed at all.
 */

const state = (name: string, hiddenInTray = false) => ({
  name,
  group: { hiddenInTray },
});

describe('src/tray-group-layout.ts', () => {
  it('keeps the visible groups in order and folds the hidden ones', () => {
    const layout = trayGroupLayout(
      [state('api'), state('web', true), state('db'), state('mq', true)],
      true,
    );
    expect(layout.shown.map((s) => s.name)).toEqual(['api', 'db']);
    expect(layout.folded.map((s) => s.name)).toEqual(['web', 'mq']);
  });

  it('drops the hidden groups when the fold is turned off', () => {
    const layout = trayGroupLayout([state('api'), state('web', true)], false);
    expect(layout.shown.map((s) => s.name)).toEqual(['api']);
    expect(layout.folded).toEqual([]);
  });
});
