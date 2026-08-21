import { describe, it, expect } from 'vitest';
import { PACKAGE_IGNORE } from '../scripts/package-electron.js';

// electron-packager tests each path (leading slash, relative to the project
// root) against every pattern; a match keeps the file out of the .app.
function isIgnored(pathname: string): boolean {
  return PACKAGE_IGNORE.some((pattern) => pattern.test(pathname));
}

describe('packaged app contents', () => {
  it('drops the dev simulation panel and its IPC handlers', () => {
    expect(isIgnored('/build/renderer/dev')).toBe(true);
    expect(isIgnored('/build/renderer/dev/dev-panel.js')).toBe(true);
    expect(isIgnored('/build/src/dev')).toBe(true);
    expect(isIgnored('/build/src/dev/dev-ipc.js')).toBe(true);
    expect(isIgnored('/build/src/dev/dev-ipc.js.map')).toBe(true);
  });

  it('keeps everything the app actually runs', () => {
    for (const kept of [
      '/build/src/main.js',
      '/build/src/preload.cjs',
      '/build/src/tray-icon.js',
      '/build/renderer/config.html',
      '/build/renderer/config.js',
      '/build/renderer/logs.js',
      '/build/assets/icon.png',
      '/package.json',
      '/node_modules/menubar/index.js',
    ]) {
      expect(isIgnored(kept), kept).toBe(false);
    }
  });

  it('still drops the TypeScript sources and dev tooling', () => {
    for (const dropped of [
      '/src/main.ts',
      '/renderer/config.ts',
      '/tests/foo.test.ts',
      '/scripts/build.sh',
      '/dist/release',
      '/.github/workflows/ci.yml',
    ]) {
      expect(isIgnored(dropped), dropped).toBe(true);
    }
  });

  it('does not catch unrelated paths that merely contain "dev"', () => {
    expect(isIgnored('/build/renderer/devbar-extra.js')).toBe(false);
    expect(isIgnored('/build/src/device-info.js')).toBe(false);
  });
});
