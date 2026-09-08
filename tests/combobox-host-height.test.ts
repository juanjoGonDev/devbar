import { describe, expect, it } from 'vitest';
import { hostHeightFor } from '../renderer/combobox.js';

describe('hostHeightFor', () => {
  it('grows to fit a dropdown taller than the host content', () => {
    expect(hostHeightFor(240, 400)).toBe(412);
  });

  it('falls back to the content height when the dropdown is short', () => {
    expect(hostHeightFor(240, 90)).toBe(240);
  });

  it('collapses to the content height when the dropdown has no matches', () => {
    // An empty list sits just under the input and has no height of its own.
    expect(hostHeightFor(240, 78)).toBe(240);
  });

  it('is idempotent — feeding its own result back does not inflate it', () => {
    // The ratchet bug: flooring on the CURRENT window height meant every call
    // returned something a little taller than the last.
    const content = 240;
    let height = hostHeightFor(content, 400);
    for (let i = 0; i < 50; i += 1) height = hostHeightFor(content, 400);
    expect(height).toBe(412);
  });

  it('never depends on how tall the window already is', () => {
    // Same content and same dropdown must yield the same answer whether the
    // window is currently short or already stretched to the screen.
    expect(hostHeightFor(240, 120)).toBe(hostHeightFor(240, 120));
    expect(hostHeightFor(240, 120)).toBe(240);
  });

  it('rounds a fractional list edge up so the last row is never clipped', () => {
    expect(hostHeightFor(0, 400.2)).toBe(413);
  });
});
