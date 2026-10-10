import { describe, expect, it } from 'vitest';
import { createVerifyTokens } from '../src/main/remote/verify-tokens.js';

/**
 * The one-time token in a device's «Código de seguridad» QR: what makes
 * `verify.done` mean "this phone scanned the code on this screen" instead of
 * something a device could simply claim.
 */

const MINUTE = 60_000;

function harness() {
  let clock = 1_000_000;
  const tokens = createVerifyTokens({ now: () => clock });
  return {
    tokens,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('src/main/remote/verify-tokens.ts', () => {
  it('issues 16 random bytes in base64url, a new one each time', () => {
    const { tokens } = harness();

    const one = tokens.issue('d1');
    const two = tokens.issue('d1');

    expect(one).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(two).not.toBe(one);
  });

  it('takes a token once, for its own device only', () => {
    const { tokens } = harness();
    const token = tokens.issue('d1');

    expect(tokens.consume('d2', token)).toBe(false);
    expect(tokens.consume('d1', token)).toBe(true);
    expect(tokens.consume('d1', token)).toBe(false);
  });

  it('keeps only the latest token of a device', () => {
    const { tokens } = harness();
    const old = tokens.issue('d1');
    const latest = tokens.issue('d1');

    expect(tokens.consume('d1', old)).toBe(false);
    expect(tokens.consume('d1', latest)).toBe(true);
  });

  it('expires a token after ten minutes', () => {
    const h = harness();
    const fresh = h.tokens.issue('d1');
    h.advance(9 * MINUTE);
    expect(h.tokens.consume('d1', fresh)).toBe(true);

    const stale = h.tokens.issue('d1');
    h.advance(10 * MINUTE);
    expect(h.tokens.consume('d1', stale)).toBe(false);
  });

  it('refuses anything that is not a token, a wrong one included', () => {
    const { tokens } = harness();
    const token = tokens.issue('d1');

    for (const value of [undefined, null, 42, '', 'short', `${token}A`])
      expect(tokens.consume('d1', value), String(value)).toBe(false);
    expect(tokens.consume('d1', 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    // A wrong guess does not burn the real one.
    expect(tokens.consume('d1', token)).toBe(true);
  });

  it('forgets one device, or every device', () => {
    const { tokens } = harness();
    const one = tokens.issue('d1');
    const two = tokens.issue('d2');
    tokens.revoke('d1');

    expect(tokens.consume('d1', one)).toBe(false);
    tokens.clear();
    expect(tokens.consume('d2', two)).toBe(false);
  });
});
