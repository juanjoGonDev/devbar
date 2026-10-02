import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATIC_FILES, staticAsset } from '../src/main/remote/static-files.js';

const RENDERER = path.join(import.meta.dirname, '..', 'renderer');

describe('src/main/remote/static-files.ts', () => {
  it('serves the page shell for the root and the pairing link', () => {
    expect(staticAsset('/')).toEqual({
      file: 'remote.html',
      type: 'text/html; charset=utf-8',
    });
    expect(staticAsset('/pair')?.file).toBe('remote.html');
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
  ])('serves nothing for %s', (pathname) => {
    expect(staticAsset(pathname)).toBeNull();
  });

  it('whitelists every compiled module of the phone page, and only those', () => {
    const modules = fs
      .readdirSync(path.join(RENDERER, 'remote'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => `remote/${file.replace(/\.ts$/, '.js')}`);
    const served = STATIC_FILES.filter((file) => file.endsWith('.js'));

    expect([...served].sort()).toEqual(['remote.js', ...modules].sort());
  });

  it('only whitelists files that exist in renderer/ (as source)', () => {
    for (const file of STATIC_FILES) {
      const source = file.endsWith('.js') ? file.replace(/\.js$/, '.ts') : file;
      expect(fs.existsSync(path.join(RENDERER, source)), source).toBe(true);
    }
  });
});
