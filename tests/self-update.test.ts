import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appImagePathFromExecutable,
  bundlePathFromExecutable,
  buildInstallerBat,
  buildLinuxSwapScript,
  buildMacSwapScript as buildSwapScript,
  buildSwapBat,
  canInstallInPlace,
  isInstalledExe,
  looksLikeAppImage,
  windowsUpdateMode,
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

describe('appImagePathFromExecutable', () => {
  it('accepts a running .AppImage path', () => {
    expect(appImagePathFromExecutable('/home/u/Apps/DevBar.AppImage')).toBe(
      '/home/u/Apps/DevBar.AppImage',
    );
  });

  it('rejects a .deb install (plain binary) and dev runs', () => {
    expect(appImagePathFromExecutable('/usr/bin/DevBar')).toBeNull();
    expect(
      appImagePathFromExecutable('/repo/node_modules/electron/dist/electron'),
    ).toBeNull();
  });
});

describe('buildLinuxSwapScript', () => {
  const script = buildLinuxSwapScript({
    pid: 777,
    target: '/home/u/Apps/DevBar.AppImage',
    staged: '/tmp/updates/0.8.0/DevBar-0.8.0-linux-x64.AppImage',
  });

  it('waits for the old process before touching the file', () => {
    const wait = script.indexOf('kill -0 777');
    const copy = script.indexOf('cp "$staged" "$target"');
    expect(wait).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(wait);
  });

  it('gives up instead of swapping when the old process never exits', () => {
    expect(script).toContain('if kill -0 777 2>/dev/null; then exit 1; fi');
  });

  it('rolls the old file back when the copy fails', () => {
    expect(script).toContain('mv "$backup" "$target"');
  });

  it('relaunches detached without the --login flag (no pre-script rerun)', () => {
    expect(script).toContain('setsid "$target" >/dev/null 2>&1 < /dev/null &');
    expect(script).not.toMatch(/setsid .*--login/);
  });
});

describe('buildSwapBat', () => {
  const bat = buildSwapBat({
    pid: 4242,
    target: 'C:\\Users\\dev\\DevBar.exe',
    staged:
      'C:\\Users\\dev\\AppData\\Roaming\\devbar\\updates\\0.8.0\\DevBar-0.8.0-win-x64-portable.exe',
  });

  it('waits for the old process (bounded) before moving the file', () => {
    expect(bat).toContain('tasklist /fi "PID eq 4242"');
    expect(bat).toContain('if %tries% geq 120 exit /b 1');
    expect(bat.indexOf(':wait')).toBeLessThan(bat.indexOf(':swap'));
  });

  it('moves the old exe aside and copies the new one into place', () => {
    expect(bat).toContain('move /y "%target%" "%backup%"');
    expect(bat).toContain('copy /y "%staged%" "%target%"');
  });

  it('rolls back and relaunches the old exe on failure', () => {
    expect(bat).toContain(':fail');
    expect(bat).toContain('move /y "%backup%" "%target%"');
    expect(bat.match(/start "" "%target%"/g)).toHaveLength(2);
  });

  it('doubles embedded quotes so they cannot break out of the bat quoting', () => {
    const tricky = buildSwapBat({
      pid: 1,
      target: 'C:\\dir "x"\\DevBar.exe',
      staged: 'C:\\z.exe',
    });
    expect(tricky).toContain('set "target="C:\\dir ""x""\\DevBar.exe""');
  });
});

describe('windows update mode + helpers', () => {
  it('detects the NSIS per-user install location', () => {
    expect(
      isInstalledExe(
        'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe',
      ),
    ).toBe(true);
    expect(
      windowsUpdateMode(
        'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe',
      ),
    ).toBe('nsis');
  });

  it('treats Program Files as assisted-only (needs elevation)', () => {
    expect(windowsUpdateMode('C:\\Program Files\\DevBar\\DevBar.exe')).toBe(
      'assisted',
    );
  });

  it('treats any other folder as a portable install', () => {
    expect(isInstalledExe('D:\\Tools\\DevBar\\DevBar.exe')).toBe(false);
    expect(windowsUpdateMode('D:\\Tools\\DevBar\\DevBar.exe')).toBe('portable');
  });
});

describe('looksLikeAppImage', () => {
  /** Real AppImage shape: ELF header + "AI" + type byte at offset 8. */
  function realImage(typeByte: number): Buffer {
    const buf = Buffer.alloc(64);
    buf.write('\x7fELF', 0, 'latin1');
    buf[8] = 0x41; // "A"
    buf[9] = 0x49; // "I"
    buf[10] = typeByte;
    return buf;
  }

  function withFile(content: Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-img-'));
    const file = path.join(dir, 'x.AppImage');
    fs.writeFileSync(file, content);
    return file;
  }

  it('rejects files shorter than the magic window', () => {
    const file = withFile(Buffer.from('short'));
    expect(looksLikeAppImage(file)).toBe(false);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('accepts the AppImageSpec magic (ELF + AI + type byte)', () => {
    expect(looksLikeAppImage(withFile(realImage(0x02)))).toBe(true);
    expect(looksLikeAppImage(withFile(realImage(0x01)))).toBe(true);
  });

  it('rejects the legacy "AppImage" string at offset 8 — real images do not carry it', () => {
    const buf = Buffer.alloc(64);
    buf.write('AppImage', 8, 'latin1');
    expect(looksLikeAppImage(withFile(buf))).toBe(false);
  });

  it('rejects an ELF file without the AppImage marker', () => {
    const buf = Buffer.alloc(64);
    buf.write('\x7fELF', 0, 'latin1');
    expect(looksLikeAppImage(withFile(buf))).toBe(false);
  });
});

describe('swap scripts: CI relaunch args + success marker', () => {
  const mac = buildSwapScript({
    pid: 7,
    target: '/Applications/DevBar.app',
    staged: '/tmp/u/v2/DevBar.app',
    relaunchArgs: ['--devbar-smoke'],
    markerPath: '/tmp/u/swap-ok',
  });
  it('macOS relaunch passes the args through `open --args` (env would not survive LaunchServices)', () => {
    expect(mac).toContain('open "$target" --args \'--devbar-smoke\'');
  });
  it('macOS writes the success marker after a clean swap', () => {
    expect(mac).toContain("printf 'ok' > '/tmp/u/swap-ok'");
  });

  const linux = buildLinuxSwapScript({
    pid: 7,
    target: '/home/x/DevBar.AppImage',
    staged: '/tmp/u/v2/DevBar.AppImage',
    relaunchArgs: ['--devbar-smoke'],
    markerPath: '/tmp/u/swap-ok',
  });
  it('Linux relaunch appends the args to the detached exec', () => {
    expect(linux).toContain('setsid "$target" \'--devbar-smoke\' >/dev/null');
  });
  it('Linux writes the success marker after a clean swap', () => {
    expect(linux).toContain("printf 'ok' > '/tmp/u/swap-ok'");
  });
  it('sh swaps strip the CI-simulation env before relaunch (no re-entrancy)', () => {
    for (const script of [mac, linux]) {
      expect(script).toContain('unset DEVBAR_SMOKE');
      expect(script).toContain('DEVBAR_SMOKE_UPDATE');
    }
  });

  const bat = buildSwapBat({
    pid: 7,
    target: 'C:\\folder with space\\DevBar.exe',
    staged: 'C:\\staged\\DevBar.exe',
    relaunchArgs: ['--devbar-smoke'],
    markerPath: 'C:\\staged\\swap-ok',
  });
  it('Windows portable bat relaunch passes the args and writes the marker', () => {
    expect(bat).toContain('start "" "%target%" "--devbar-smoke"');
    expect(bat).toContain('echo ok> "C:\\staged\\swap-ok" 2>nul');
  });
});

describe('buildInstallerBat', () => {
  const bat = buildInstallerBat({ pid: 4321, installer: 'C:\\u\\setup.exe' });
  it('waits for the old pid before launching the installer', () => {
    const wait = bat.indexOf('tasklist /fi "PID eq 4321"');
    const run = bat.indexOf('start "" "C:\\u\\setup.exe" /S');
    expect(wait).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(run);
  });
  it('gives up instead of installing over a stuck process', () => {
    expect(bat).toContain('if %tries% geq 120 exit /b 1');
  });
});
