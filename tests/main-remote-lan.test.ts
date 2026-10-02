import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  isAllowedHost,
  isPrivateIPv4,
  lanAddresses,
  normalizeIp,
} from '../src/main/remote/lan.js';

function nic(
  address: string,
  family: 'IPv4' | 'IPv6' = 'IPv4',
  internal = false,
): os.NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  } as os.NetworkInterfaceInfo;
}

describe('src/main/remote/lan.ts', () => {
  describe('isPrivateIPv4', () => {
    it.each(['10.0.0.1', '172.16.4.2', '172.31.255.255', '192.168.1.20'])(
      'accepts %s',
      (address) => {
        expect(isPrivateIPv4(address)).toBe(true);
      },
    );

    it.each([
      '8.8.8.8',
      '172.32.0.1',
      '172.15.0.1',
      '127.0.0.1',
      '169.254.1.1',
      'nope',
      '192.168.1',
    ])('rejects %s', (address) => {
      expect(isPrivateIPv4(address)).toBe(false);
    });
  });

  describe('lanAddresses', () => {
    it('keeps the private, external IPv4 addresses only', () => {
      expect(
        lanAddresses({
          lo0: [nic('127.0.0.1', 'IPv4', true), nic('::1', 'IPv6', true)],
          en0: [nic('fe80::1', 'IPv6'), nic('192.168.1.20')],
          utun3: [nic('100.64.0.2')],
          en7: [nic('10.0.0.5')],
          bridge: undefined,
        }),
      ).toEqual(['192.168.1.20', '10.0.0.5']);
    });

    it('also understands the numeric family some Node versions report', () => {
      const legacy = {
        ...nic('192.168.0.3'),
        family: 4,
      } as unknown as os.NetworkInterfaceInfo;

      expect(lanAddresses({ en0: [legacy] })).toEqual(['192.168.0.3']);
    });

    it('drops duplicates', () => {
      expect(
        lanAddresses({ en0: [nic('10.0.0.5')], en1: [nic('10.0.0.5')] }),
      ).toEqual(['10.0.0.5']);
    });
  });

  describe('isAllowedHost', () => {
    const lan = ['192.168.1.20'];

    it('accepts a LAN address or loopback with the server port', () => {
      expect(isAllowedHost('192.168.1.20:47821', lan, 47821)).toBe(true);
      expect(isAllowedHost('localhost:47821', lan, 47821)).toBe(true);
      expect(isAllowedHost('LOCALHOST:47821', lan, 47821)).toBe(true);
      expect(isAllowedHost('127.0.0.1:47821', lan, 47821)).toBe(true);
    });

    it('refuses any other name, a wrong port or no host at all', () => {
      expect(isAllowedHost('evil.example:47821', lan, 47821)).toBe(false);
      expect(isAllowedHost('192.168.1.20', lan, 47821)).toBe(false);
      expect(isAllowedHost('192.168.1.20:80', lan, 47821)).toBe(false);
      expect(isAllowedHost('192.168.1.21:47821', lan, 47821)).toBe(false);
      expect(isAllowedHost(undefined, lan, 47821)).toBe(false);
    });
  });

  describe('normalizeIp', () => {
    it('unwraps an IPv4-mapped IPv6 address', () => {
      expect(normalizeIp('::ffff:192.168.1.40')).toBe('192.168.1.40');
      expect(normalizeIp('192.168.1.40')).toBe('192.168.1.40');
      expect(normalizeIp(undefined)).toBe('desconocida');
    });
  });
});
