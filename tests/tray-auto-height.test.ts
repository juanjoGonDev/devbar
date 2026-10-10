// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installAutoHeight,
  type AutoHeight,
} from '../renderer/tray/auto-height.js';

describe('renderer/tray/auto-height.ts', () => {
  let root: HTMLElement;
  let height = 300;
  let suspended = false;
  let sent: number[] = [];
  let frames: (() => void)[] = [];
  let auto: AutoHeight | null = null;

  /** Runs every animation frame queued so far. */
  function flushFrames(): void {
    const queued = frames;
    frames = [];
    for (const run of queued) run();
  }

  /** Lets the MutationObserver deliver, then runs the frame it queued. */
  async function settle(): Promise<void> {
    await Promise.resolve();
    flushFrames();
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root') as HTMLElement;
    height = 300;
    suspended = false;
    sent = [];
    frames = [];
    auto = installAutoHeight({
      root,
      measure: () => height,
      send: (h) => sent.push(h),
      isSuspended: () => suspended,
      frame: (run) => {
        frames.push(run);
        return frames.length;
      },
      cancelFrame: () => {
        frames = [];
      },
    });
  });

  afterEach(() => {
    auto?.disconnect();
    auto = null;
  });

  it('follows a row added while the popover is open', async () => {
    root.appendChild(document.createElement('div'));
    height = 340;
    await settle();
    expect(sent).toEqual([340]);
  });

  it('follows a banner shown by flipping an attribute', async () => {
    const banner = document.createElement('div');
    banner.hidden = true;
    root.appendChild(banner);
    await settle();
    height = 360;
    banner.hidden = false;
    await settle();
    expect(sent).toEqual([300, 360]);
  });

  it('measures a burst of changes once', async () => {
    for (let i = 0; i < 5; i++) root.appendChild(document.createElement('p'));
    await settle();
    expect(sent).toEqual([300]);
  });

  it('does not resend a height that did not change', async () => {
    // The uptime ticker rewrites text every second; the IPC must not follow.
    root.textContent = '0:01';
    await settle();
    root.textContent = '0:02';
    await settle();
    expect(sent).toEqual([300]);
  });

  it('resends on demand, even when the content height did not change', async () => {
    root.appendChild(document.createElement('div'));
    await settle();
    // A closed dropdown had grown the window past the content: it must shrink
    // back to the very height that was sent before.
    auto?.schedule(true);
    flushFrames();
    expect(sent).toEqual([300, 300]);
  });

  it('holds still while a dropdown owns the height', async () => {
    suspended = true;
    root.appendChild(document.createElement('div'));
    await settle();
    expect(sent).toEqual([]);
  });

  it('measures the content, not the window, so a resize cannot loop', async () => {
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(sent).toEqual([]);
  });

  it('stops following once disconnected', async () => {
    auto?.disconnect();
    root.appendChild(document.createElement('div'));
    await settle();
    expect(sent).toEqual([]);
  });
});
