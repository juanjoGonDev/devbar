import { describe, expect, it } from 'vitest';
import { placeTip, type Box } from '../renderer/tooltip.js';

function box(left: number, top: number, width = 60, height = 16): Box {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

const TIP = { width: 200, height: 28 };
const VIEW = { width: 900, height: 600 };

describe('placeTip', () => {
  it('sits just below the anchor when there is room', () => {
    const { top } = placeTip(box(100, 100), TIP, VIEW);
    expect(top).toBe(100 + 16 + 6); // anchor bottom + gap
  });

  it('left-aligns with the anchor when it fits', () => {
    expect(placeTip(box(100, 100), TIP, VIEW).left).toBe(100);
  });

  it('flips above when the anchor is at the bottom edge', () => {
    const anchor = box(100, 580);
    const { top } = placeTip(anchor, TIP, VIEW);
    expect(top).toBe(580 - 6 - 28); // anchor top - gap - tip height
    expect(top + TIP.height).toBeLessThan(anchor.top);
  });

  it('clamps to the right edge instead of overflowing', () => {
    const { left } = placeTip(box(850, 100), TIP, VIEW);
    expect(left).toBe(900 - 200 - 8);
    expect(left + TIP.width).toBeLessThanOrEqual(900);
  });

  it('never goes past the left margin', () => {
    expect(placeTip(box(0, 100), TIP, VIEW).left).toBe(8);
  });

  it('stays on screen in a viewport narrower than the tip', () => {
    // The tray popover is ~380px wide; a long tip must not run off it.
    const { left } = placeTip(
      box(10, 40),
      { width: 500, height: 28 },
      {
        width: 380,
        height: 500,
      },
    );
    expect(left).toBe(8);
  });

  it('keeps the top margin when flipping in a very short viewport', () => {
    const { top } = placeTip(box(10, 10), TIP, { width: 900, height: 40 });
    expect(top).toBeGreaterThanOrEqual(8);
  });
});
