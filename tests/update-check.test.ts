import { describe, it, expect } from 'vitest';
import {
  isNewerVersion,
  selectAssetUrl,
  parseReleases,
  releaseAssetSuffixes,
} from '../src/update-check.js';

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

describe('releaseAssetSuffixes', () => {
  it('maps each platform to its installer family', () => {
    expect(releaseAssetSuffixes('darwin', 'arm64')).toEqual({
      dmg: 'macos-arm64.dmg',
      zip: 'macos-arm64.zip',
    });
    expect(releaseAssetSuffixes('win32', 'x64')).toEqual({
      setup: 'win-x64-setup.exe',
      zip: 'win-x64-portable.exe',
    });
    expect(releaseAssetSuffixes('linux', 'arm64')).toEqual({
      appImage: 'linux-arm64.AppImage',
      deb: 'linux-arm64.deb',
    });
  });

  it('treats unknown platforms like linux', () => {
    expect(releaseAssetSuffixes('freebsd', 'x64')).toEqual({
      appImage: 'linux-x64.AppImage',
      deb: 'linux-x64.deb',
    });
  });
});

describe('selectAssetUrl', () => {
  const assets = [
    { name: 'DevBar-0.4.0-macos-arm64.dmg', browser_download_url: 'u/arm.dmg' },
    { name: 'DevBar-0.4.0-macos-arm64.zip', browser_download_url: 'u/arm.zip' },
    { name: 'DevBar-0.4.0-macos-x64.dmg', browser_download_url: 'u/x64.dmg' },
    { name: 'DevBar-0.4.0-macos-x64.zip', browser_download_url: 'u/x64.zip' },
    {
      name: 'DevBar-0.4.0-win-x64-setup.exe',
      browser_download_url: 'u/win-setup',
    },
    {
      name: 'DevBar-0.4.0-win-x64-portable.exe',
      browser_download_url: 'u/win-portable',
    },
    {
      name: 'DevBar-0.4.0-linux-x64.AppImage',
      browser_download_url: 'u/appimage',
    },
    { name: 'DevBar-0.4.0-linux-x64.deb', browser_download_url: 'u/deb' },
    { name: 'checksums.txt', browser_download_url: 'u/checksums' },
  ];

  it('picks the dmg for the given architecture', () => {
    expect(selectAssetUrl(assets, 'macos-arm64.dmg')).toBe('u/arm.dmg');
    expect(selectAssetUrl(assets, 'macos-x64.dmg')).toBe('u/x64.dmg');
  });

  it('picks the zip for the given architecture', () => {
    expect(selectAssetUrl(assets, 'macos-arm64.zip')).toBe('u/arm.zip');
  });

  it('picks the windows and linux installers', () => {
    expect(selectAssetUrl(assets, 'win-x64-setup.exe')).toBe('u/win-setup');
    expect(selectAssetUrl(assets, 'win-x64-portable.exe')).toBe(
      'u/win-portable',
    );
    expect(selectAssetUrl(assets, 'linux-x64.AppImage')).toBe('u/appimage');
    expect(selectAssetUrl(assets, 'linux-x64.deb')).toBe('u/deb');
  });

  it('returns null when no asset matches', () => {
    expect(selectAssetUrl(assets, 'macos-arm64.pkg')).toBe(null);
    expect(selectAssetUrl(assets, 'win-ppc-setup.exe')).toBe(null);
    expect(selectAssetUrl([], 'macos-arm64.dmg')).toBe(null);
    expect(selectAssetUrl(null, 'macos-arm64.dmg')).toBe(null);
  });
});

describe('parseReleases', () => {
  const raw = [
    {
      tag_name: 'v0.4.0',
      name: '0.4.0',
      body: 'notes',
      html_url: 'u/4',
      published_at: '2026-08-01T10:00:00Z',
    },
    { tag_name: '0.3.0', body: '', html_url: 'u/3', draft: true },
    { tag_name: 'v0.2.0', html_url: 'u/2', prerelease: true },
  ];

  it('strips leading v, keeps fields, and flags prereleases', () => {
    const out = parseReleases(raw);
    expect(out.map((r) => r.version)).toEqual(['0.4.0', '0.2.0']); // draft skipped
    expect(out[0]).toMatchObject({ body: 'notes', url: 'u/4' });
    expect(out[1].prerelease).toBe(true);
  });

  it('respects the limit and tolerates junk', () => {
    expect(parseReleases(raw, 1)).toHaveLength(1);
    expect(parseReleases(null)).toEqual([]);
    expect(parseReleases(undefined)).toEqual([]);
  });
});
