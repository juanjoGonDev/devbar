import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATIC_FILES, staticAsset } from '../src/main/remote/static-files.js';

const RENDERER = path.join(import.meta.dirname, '..', 'renderer');

describe('src/main/remote/static-files.ts', () => {
  it('serves the page shell for the root, the pairing and the verification links', () => {
    expect(staticAsset('/')).toEqual({
      file: 'remote.html',
      type: 'text/html; charset=utf-8',
    });
    expect(staticAsset('/pair')?.file).toBe('remote.html');
    expect(staticAsset('/verify')?.file).toBe('remote.html');
  });

  it('labels stylesheets and modules with their content types', () => {
    expect(staticAsset('/remote.css')?.type).toBe('text/css; charset=utf-8');
    expect(staticAsset('/remote.js')?.type).toBe(
      'text/javascript; charset=utf-8',
    );
  });

  it('serves the web manifest and home-screen icons with their types', () => {
    expect(staticAsset('/remote.webmanifest')).toEqual({
      file: 'remote.webmanifest',
      type: 'application/manifest+json',
    });
    for (const size of [192, 512])
      expect(staticAsset(`/remote-icon-${size}.png`)).toEqual({
        file: `remote-icon-${size}.png`,
        type: 'image/png',
      });
  });

  it('declares manifest icons that are whitelisted and really that size', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(RENDERER, 'remote.webmanifest'), 'utf8'),
    ) as {
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((icon) => icon.sizes).sort()).toEqual([
      '192x192',
      '512x512',
    ]);
    for (const icon of manifest.icons) {
      const asset = staticAsset(icon.src);
      expect(asset?.type, icon.src).toBe(icon.type);
      // PNG IHDR: width and height are big-endian at bytes 16 and 20.
      const png = fs.readFileSync(path.join(RENDERER, asset?.file ?? ''));
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(png.readUInt32BE(16), icon.src).toBe(width);
      expect(png.readUInt32BE(20), icon.src).toBe(height);
    }
  });

  it('links the manifest and the touch icon from the page head', () => {
    const html = fs.readFileSync(path.join(RENDERER, 'remote.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="remote.webmanifest" />');
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="remote-icon-192.png" />',
    );
  });

  it.each([
    '/config.html',
    '/remote.ts',
    '/../src/main.js',
    '/remote/../config.js',
    '/%2e%2e/package.json',
    '/remote.js.map',
    '/REMOTE.JS',
    '/remote/app.js',
    '/remote/rc-protocol.js',
  ])('serves nothing for %s', (pathname) => {
    expect(staticAsset(pathname)).toBeNull();
  });

  it('serves the phone page as its one bundle, and no module of it', () => {
    // scripts/build.ts bundles renderer/remote.ts (and everything it
    // imports, the @noble crypto included) into build/renderer/remote.js.
    const served = STATIC_FILES.filter((file) => file.endsWith('.js'));

    expect(served).toEqual(['remote.js']);
  });

  it('serves exactly the shell, its styles, the bundle and the home-screen files', () => {
    expect([...STATIC_FILES].sort()).toEqual(
      [
        'emoji.css',
        'remote-icon-192.png',
        'remote-icon-512.png',
        'remote.css',
        'remote.html',
        'remote.js',
        'remote.webmanifest',
      ].sort(),
    );
  });

  it('only whitelists files that exist in renderer/ (as source)', () => {
    for (const file of STATIC_FILES) {
      const source = file.endsWith('.js') ? file.replace(/\.js$/, '.ts') : file;
      expect(fs.existsSync(path.join(RENDERER, source)), source).toBe(true);
    }
  });
});
