import { describe, expect, it } from 'vitest';
import type { Menubar } from 'menubar';
import { createTrayHost } from '../src/main/tray-host.js';

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

function harness(bar: Menubar | null) {
  return createTrayHost(
    () => bar,
    {
      workAreaFor: () => workArea,
      displays: () => [{ id: 1, workArea }],
      displayMatching: () => ({ id: 1, workArea }),
      nativeWayland: false,
      platform: 'darwin',
    },
    { getTrayPopover: () => null, saveTrayPopover: () => undefined },
  );
}

function fakeBar(visible: boolean, calls: string[]): Menubar {
  return {
    window: { isVisible: () => visible },
    hideWindow: () => calls.push('hide'),
    tray: { getBounds: () => ({ x: 900, y: 0, width: 22, height: 22 }) },
  } as unknown as Menubar;
}

describe('src/main/tray-host.ts', () => {
  it('hides the popover only while it is on screen', () => {
    const calls: string[] = [];
    harness(fakeBar(false, calls)).hideIfVisible();
    expect(calls).toEqual([]);
    harness(fakeBar(true, calls)).hideIfVisible();
    expect(calls).toEqual(['hide']);
  });

  it('answers with nothing before menubar exists', () => {
    const host = harness(null);
    expect(host.popover()).toBeNull();
    expect(host.trayIconBounds()).toBeNull();
    expect(host.pinned.isPinned()).toBe(false);
  });

  it('reads the tray icon bounds from menubar', () => {
    expect(harness(fakeBar(true, [])).trayIconBounds()).toEqual({
      x: 900,
      y: 0,
      width: 22,
      height: 22,
    });
  });
});
