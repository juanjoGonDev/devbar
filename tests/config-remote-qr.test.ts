// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { qrSvg } from '../renderer/config/remote-qr.js';

describe('renderer/config/remote-qr.ts', () => {
  // A 3×3 "QR": dark corners and centre.
  const qr = {
    size: 3,
    modules: [true, false, true, false, true, false, true, false, true],
  };

  it('builds a real SVG element with a four-module quiet zone', () => {
    const svg = qrSvg(qr);

    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 11 11');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
  });

  it('draws one square per dark module, offset by the quiet zone', () => {
    const d = qrSvg(qr).querySelector('path')?.getAttribute('d') ?? '';

    expect(d.match(/M/g)).toHaveLength(5);
    expect(d).toContain('M4 4h1v1h-1z');
    expect(d).toContain('M5 5h1v1h-1z');
    expect(d).toContain('M6 6h1v1h-1z');
    expect(d).not.toContain('M5 4h1');
  });
});
