import { describe, expect, it } from 'vitest';
import { isRemotePort, remotePortError } from '../src/remote-port.js';

const RANGE_ERROR = 'El puerto debe ser un número entero entre 1024 y 65535.';

describe('src/remote-port.ts', () => {
  describe('isRemotePort', () => {
    it.each([1024, 47821, 65535])('accepts %d', (port) => {
      expect(isRemotePort(port)).toBe(true);
    });

    it.each([
      ['a privileged port', 80],
      ['one below the range', 1023],
      ['one above the range', 65536],
      ['a fraction', 50000.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a numeric string', '50000'],
      ['nothing', undefined],
    ])('rejects %s', (_label, value) => {
      expect(isRemotePort(value)).toBe(false);
    });
  });

  describe('remotePortError', () => {
    it('has nothing to say about a usable port', () => {
      expect(remotePortError(50000)).toBeNull();
    });

    it('explains the range in Spanish otherwise', () => {
      expect(remotePortError(80)).toBe(RANGE_ERROR);
      expect(remotePortError(Number.NaN)).toBe(RANGE_ERROR);
    });
  });
});
