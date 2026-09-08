import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bundlePathFromExecutable,
  buildSwapScript,
  canInstallInPlace,
} from '../src/self-update.js';

describe('bundlePathFromExecutable', () => {
  it('walks up from the bundle executable to the .app', () => {
    expect(
      bundlePathFromExecutable(
        '/Applications/DevBar.app/Contents/MacOS/DevBar',
      ),
    ).toBe('/Applications/DevBar.app');
  });

  it('returns null when the executable is not inside a bundle', () => {
    expect(
      bundlePathFromExecutable('/repo/node_modules/electron/dist/electron'),
    ).toBeNull();
  });
});

describe('canInstallInPlace', () => {
  it('rejects a null bundle', () => {
    expect(canInstallInPlace(null)).toBe(false);
  });

  it('accepts a bundle whose parent directory is writable', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-swap-'));
    expect(canInstallInPlace(path.join(parent, 'DevBar.app'))).toBe(true);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('rejects a bundle whose parent directory does not exist', () => {
    expect(canInstallInPlace('/nope/definitely/missing/DevBar.app')).toBe(
      false,
    );
  });
});

describe('buildSwapScript', () => {
  const script = buildSwapScript({
    pid: 4321,
    target: '/Applications/DevBar.app',
    staged: '/tmp/updates/0.7.0/DevBar.app',
  });

  it('waits for the old process before touching the bundle', () => {
    const wait = script.indexOf('kill -0 4321');
    const move = script.indexOf('mv "$target" "$backup"');
    expect(wait).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(wait);
  });

  it('gives up instead of swapping when the old process never exits', () => {
    expect(script).toContain('if kill -0 4321 2>/dev/null; then exit 1; fi');
  });

  it('rolls the old bundle back when the copy fails', () => {
    expect(script).toContain('mv "$backup" "$target"');
    // The backup is only discarded past the rollback, on the success path.
    expect(script.lastIndexOf('rm -rf "$backup"')).toBeGreaterThan(
      script.indexOf('mv "$backup" "$target"'),
    );
  });

  it('reopens the app on both the success and the rollback path', () => {
    expect(script.match(/open "\$target"/g)).toHaveLength(2);
  });

  it('quotes paths so spaces and quotes cannot break out', () => {
    const tricky = buildSwapScript({
      pid: 1,
      target: "/Apps/Dev Bar's.app",
      staged: '/tmp/a b/DevBar.app',
    });
    expect(tricky).toContain(`target='/Apps/Dev Bar'\\''s.app'`);
    expect(tricky).toContain(`staged='/tmp/a b/DevBar.app'`);
  });
});
