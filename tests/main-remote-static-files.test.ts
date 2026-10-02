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
