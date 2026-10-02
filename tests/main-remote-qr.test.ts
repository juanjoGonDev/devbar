import { describe, expect, it } from 'vitest';
import { qrMatrix } from '../src/main/remote/qr.js';

const URL_TEXT = 'http://192.168.1.20:47821/pair?c=AbCdEfGhIjKlMnOpQrStUvWx';

/** The 7×7 finder pattern every QR carries in three corners. */
function hasFinderAt(
  qr: { size: number; modules: boolean[] },
  top: number,
  left: number,
): boolean {
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (qr.modules[(top + r) * qr.size + left + c] !== (ring || core))
        return false;
    }
  return true;
}

describe('src/main/remote/qr.ts', () => {
  it('returns a square, row-major module matrix', () => {
    const qr = qrMatrix(URL_TEXT);

    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect((qr.size - 17) % 4).toBe(0);
    expect(qr.modules).toHaveLength(qr.size * qr.size);
  });

  it('draws the three finder patterns where a scanner looks for them', () => {
    const qr = qrMatrix(URL_TEXT);

    expect(hasFinderAt(qr, 0, 0)).toBe(true);
    expect(hasFinderAt(qr, 0, qr.size - 7)).toBe(true);
    expect(hasFinderAt(qr, qr.size - 7, 0)).toBe(true);
  });

  it('is deterministic and depends on the text', () => {
    expect(qrMatrix(URL_TEXT)).toEqual(qrMatrix(URL_TEXT));
    expect(qrMatrix(URL_TEXT).modules).not.toEqual(
      qrMatrix(URL_TEXT.replace('AbC', 'XyZ')).modules,
    );
  });
});
