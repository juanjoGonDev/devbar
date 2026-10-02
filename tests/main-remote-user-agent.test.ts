import { describe, expect, it } from 'vitest';
import {
  clientLabel,
  suggestedDeviceName,
} from '../src/main/remote/user-agent.js';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidFirefox:
    'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linuxFirefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  chromebookOpera:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
};

describe('src/main/remote/user-agent.ts', () => {
  describe('clientLabel', () => {
    it.each([
      [UA.iphoneSafari, 'Safari · iOS'],
      [UA.iphoneChrome, 'Chrome · iOS'],
      [UA.ipad, 'Safari · iPadOS'],
      [UA.androidChrome, 'Chrome · Android'],
      [UA.androidSamsung, 'Samsung Internet · Android'],
      [UA.androidFirefox, 'Firefox · Android'],
      [UA.windowsEdge, 'Edge · Windows'],
      [UA.macSafari, 'Safari · macOS'],
      [UA.linuxFirefox, 'Firefox · Linux'],
      [UA.chromebookOpera, 'Opera · ChromeOS'],
    ])('labels %s as %s', (ua, label) => {
      expect(clientLabel(ua)).toBe(label);
    });

    it('falls back to a generic label for an unknown or missing agent', () => {
      expect(clientLabel('curl/8.4.0')).toBe('Navegador');
      expect(clientLabel(undefined)).toBe('Navegador');
    });
  });

  describe('suggestedDeviceName', () => {
    it.each([
      [UA.iphoneSafari, 'iPhone'],
      [UA.ipad, 'iPad'],
      [UA.androidChrome, 'Móvil Android'],
      [UA.windowsEdge, 'PC con Windows'],
      [UA.macSafari, 'Mac'],
      [UA.linuxFirefox, 'Equipo Linux'],
      [UA.chromebookOpera, 'Chromebook'],
      ['curl/8.4.0', 'Mi dispositivo'],
    ])('suggests a name for %s', (ua, name) => {
      expect(suggestedDeviceName(ua)).toBe(name);
    });
  });
});
