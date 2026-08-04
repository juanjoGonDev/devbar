import { describe, it, expect } from 'vitest';
import { isNewerVersion, selectAssetUrl } from '../src/update-check.js';

describe('isNewerVersion', () => {
  it('detects a higher patch/minor/major', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('is false for equal or older', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
  });

  it('ignores a leading v and ragged lengths', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.1', '0.1.0')).toBe(false);
  });
});

describe('selectAssetUrl', () => {
  const assets = [
    { name: 'DevBar-0.4.0-macos-arm64.dmg', browser_download_url: 'u/arm.dmg' },
    { name: 'DevBar-0.4.0-macos-arm64.zip', browser_download_url: 'u/arm.zip' },
    { name: 'DevBar-0.4.0-macos-x64.dmg', browser_download_url: 'u/x64.dmg' },
    { name: 'DevBar-0.4.0-macos-x64.zip', browser_download_url: 'u/x64.zip' },
    { name: 'checksums.txt', browser_download_url: 'u/checksums' },
  ];

  it('picks the dmg for the given architecture', () => {
    expect(selectAssetUrl(assets, 'arm64', 'dmg')).toBe('u/arm.dmg');
    expect(selectAssetUrl(assets, 'x64', 'dmg')).toBe('u/x64.dmg');
  });

  it('picks the zip for the given architecture', () => {
    expect(selectAssetUrl(assets, 'arm64', 'zip')).toBe('u/arm.zip');
  });

  it('returns null when no asset matches', () => {
    expect(selectAssetUrl(assets, 'arm64', 'pkg')).toBe(null);
    expect(selectAssetUrl(assets, 'ppc', 'dmg')).toBe(null);
    expect(selectAssetUrl([], 'arm64', 'dmg')).toBe(null);
    expect(selectAssetUrl(null, 'arm64', 'dmg')).toBe(null);
  });
});
