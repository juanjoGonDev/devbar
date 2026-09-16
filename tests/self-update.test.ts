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
  isPortableContainer,
  isUnderTempDir,
  looksLikeAppImage,
  winInstalledAppPath,
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

  it('resolves the image from $APPIMAGE when running a mounted type 2 image', () => {
    // A running type 2 AppImage executes the payload from the tmp mount —
    // execPath alone would never end in .AppImage and the in-place path
    // would be dead for every real install.
    expect(
      appImagePathFromExecutable(
        '/tmp/.mount_DevBarXYz/devbar',
        '/home/u/Apps/DevBar.AppImage',
      ),
    ).toBe('/home/u/Apps/DevBar.AppImage');
  });

  it('accepts a FOREIGN-free $APPIMAGE for a directly executed image', () => {
    // Direct execution: the execPath IS the image file; an env pointing at
    // the same image is consistent (and a blank one falls through).
    expect(
      appImagePathFromExecutable(
        '/home/u/Apps/DevBar.AppImage',
        '/home/u/Apps/DevBar.AppImage',
      ),
    ).toBe('/home/u/Apps/DevBar.AppImage');
    expect(
      appImagePathFromExecutable('/home/u/Apps/DevBar.AppImage', '   '),
    ).toBe('/home/u/Apps/DevBar.AppImage');
    expect(appImagePathFromExecutable('/usr/bin/devbar', '   ')).toBeNull();
  });

  it('rejects an inherited $APPIMAGE (child of another AppImage)', () => {
    // DevBar running INSIDE another image: the parent's runtime set
    // $APPIMAGE to the parent file. The mount dir stem must match the env
    // stem — otherwise the update would replace the PARENT APPLICATION.
    expect(
      appImagePathFromExecutable(
        '/tmp/.mount_DevBarXYz/devbar',
        '/opt/Tools/Tool.AppImage',
      ),
    ).toBeNull();
    // …while the env that names the running image itself is accepted.
    expect(
      appImagePathFromExecutable(
        '/tmp/.mount_DevBarXYz/devbar',
        '/home/u/Apps/DevBar.AppImage',
      ),
    ).toBe('/home/u/Apps/DevBar.AppImage');
  });

  it('matches the mount stem case-insensitively on the extension', () => {
    expect(
      appImagePathFromExecutable(
        '/tmp/.mount_devbar12/devbar',
        '/home/u/devbar.appimage',
      ),
    ).toBe('/home/u/devbar.appimage');
  });
});

describe('winInstalledAppPath (temp payload without a resolvable container)', () => {
  const tmp = os.tmpdir();
  const tempPayload = path.join(tmp, 'devbar-portable-payload', 'devbar.exe');
  const container = 'C:\\Users\\dev\\Downloads\\DevBar-Portable.exe';

  it('returns the portable container when it is known', () => {
    expect(winInstalledAppPath(tempPayload, container)).toBe(container);
  });

  it('returns null when the container lookup failed for a temp payload', () => {
    // Targeting the ephemeral extraction copy would "update" a file that
    // dies with the temp dir while the user's real portable file keeps the
    // old version — no target beats a wrong target.
    expect(winInstalledAppPath(tempPayload, null)).toBeNull();
  });

  it('keeps the execPath fallback for non-temp installs', () => {
    const nsis = 'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe';
    expect(winInstalledAppPath(nsis, null)).toBe(nsis);
    expect(winInstalledAppPath('D:\\Tools\\DevBar\\DevBar.exe', null)).toBe(
      'D:\\Tools\\DevBar\\DevBar.exe',
    );
  });

  it('isUnderTempDir: temp paths only, with the separator boundary intact', () => {
    expect(isUnderTempDir(tempPayload)).toBe(true);
    // Sibling dir that merely shares the prefix must NOT match.
    const sep = tmp.includes('\\') ? '\\' : '/';
    expect(isUnderTempDir(`${tmp}${sep}x`)).toBe(true);
    expect(isUnderTempDir(`${tmp.replace(/[/\\]$/u, '')}other/x`)).toBe(false);
    expect(isUnderTempDir('C:\\Tools\\devbar.exe')).toBe(false);
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
    expect(bat).toContain('if %tries% geq 150 (');
    expect(bat.indexOf(':wait')).toBeLessThan(bat.indexOf(':swap'));
  });

  it('checks the pid without a pipe (tasklist|find hangs in the hidden detached context)', () => {
    expect(bat).toContain(
      'tasklist /fi "PID eq 4242" /fo csv > "%~dp0devbar-pid.tmp" 2>nul',
    );
    expect(bat).toContain(
      'findstr /i "DevBar" "%~dp0devbar-pid.tmp" >nul 2>&1',
    );
    expect(bat).not.toContain('| find');
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

  it('stores space-containing paths unquoted so "%var%" expansion stays one quoted argument', () => {
    // `set "name=value"` keeps everything to the final quote as the
    // value. Wrapping the value in its own quotes (batQuote) would
    // embed literal quotes in %target%, and every later `"%target%"`
    // would expand to a broken double-quoted path — the exact failure
    // for a directory with a space.
    const spaced = buildSwapBat({
      pid: 1,
      target: 'C:\\Program Files (x86)\\DevBar\\DevBar.exe',
      staged: 'C:\\Program Files (x86)\\DevBar\\staged\\DevBar.exe',
    });
    expect(spaced).toContain(
      'set "target=C:\\Program Files (x86)\\DevBar\\DevBar.exe"',
    );
    expect(spaced).toContain(
      'set "staged=C:\\Program Files (x86)\\DevBar\\staged\\DevBar.exe"',
    );
    expect(spaced).not.toContain('set "target="');
    expect(spaced).toContain('move /y "%target%" "%backup%"');
  });
});

describe('isPortableContainer (the swap must target the stub, not the temp payload)', () => {
  const payload = 'C:\\Users\\u\\AppData\\Local\\Temp\\devbar-x\\DevBar.exe';
  it('accepts a devbar-named parent exe outside Program Files', () => {
    expect(
      isPortableContainer(
        payload,
        'D:\\Apps\\DevBar-0.7.1-win-x64-portable.exe',
      ),
    ).toBe(true);
    // A user-renamed file keeps the app name.
    expect(isPortableContainer(payload, 'D:\\Apps\\devbar.exe')).toBe(true);
  });
  it('rejects a parent that is not a devbar exe (explorer, renamed stub)', () => {
    expect(isPortableContainer(payload, 'C:\\Windows\\explorer.exe')).toBe(
      false,
    );
    expect(isPortableContainer(payload, 'D:\\Apps\\launcher.exe')).toBe(false);
  });
  it('rejects itself and a missing parent', () => {
    expect(isPortableContainer(payload, payload)).toBe(false);
    expect(isPortableContainer(payload, null)).toBe(false);
  });
  it('rejects Program Files (assisted-only, elevation-requiring location)', () => {
    expect(
      isPortableContainer(payload, 'C:\\Program Files\\DevBar\\DevBar.exe'),
    ).toBe(false);
    expect(
      isPortableContainer(
        payload,
        'C:\\Program Files (x86)\\DevBar\\DevBar.exe',
      ),
    ).toBe(false);
  });
});

describe('windows update mode + helpers', () => {
  const localAppData = 'C:\\Users\\dev\\AppData\\Local';

  it('detects the NSIS per-user install location (exact match)', () => {
    expect(
      isInstalledExe(
        'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe',
        localAppData,
      ),
    ).toBe(true);
    expect(
      windowsUpdateMode(
        'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe',
        localAppData,
      ),
    ).toBe('nsis');
  });

  it('is case-insensitive but not suffix-matching', () => {
    expect(
      isInstalledExe(
        'c:\\users\\dev\\appdata\\local\\programs\\devbar\\devbar.exe',
        'c:\\Users\\dev\\AppData\\Local',
      ),
    ).toBe(true);
    // A folder that merely ENDS in "programs" on another drive / with a
    // "programs" suffix is a portable install, not a per-user NSIS one.
    expect(
      isInstalledExe('D:\\Programs\\DevBar\\DevBar.exe', localAppData),
    ).toBe(false);
    expect(
      isInstalledExe('C:\\NotPrograms\\DevBar\\DevBar.exe', localAppData),
    ).toBe(false);
    expect(
      windowsUpdateMode('D:\\Programs\\DevBar\\DevBar.exe', localAppData),
    ).toBe('portable');
    // No LOCALAPPDATA (unknown install root) is never an NSIS install.
    expect(
      isInstalledExe(
        'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe',
        '',
      ),
    ).toBe(false);
  });

  it('treats Program Files as assisted-only (needs elevation)', () => {
    expect(
      windowsUpdateMode('C:\\Program Files\\DevBar\\DevBar.exe', localAppData),
    ).toBe('assisted');
  });

  it('treats any other folder as a portable install', () => {
    expect(isInstalledExe('D:\\Tools\\DevBar\\DevBar.exe', localAppData)).toBe(
      false,
    );
    expect(
      windowsUpdateMode('D:\\Tools\\DevBar\\DevBar.exe', localAppData),
    ).toBe('portable');
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

  it('rejects a file that is ELF-prefixed but shorter than the magic window', () => {
    // 9 bytes: the 4-byte ELF read at offset 0 succeeds, so execution
    // reaches the 3-byte magic read at offset 8, which only gets 1 byte
    // and must return false via the short-read guard.
    const buf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from('short', 'latin1'),
    ]);
    expect(buf.length).toBe(9);
    expect(looksLikeAppImage(withFile(buf))).toBe(false);
  });

  it('accepts the AppImageSpec magic (ELF + AI + type byte)', () => {
    expect(looksLikeAppImage(withFile(realImage(0x02)))).toBe(true);
    expect(looksLikeAppImage(withFile(realImage(0x01)))).toBe(true);
  });

  it('rejects the legacy "AppImage" string at offset 8 — real images do not carry it', () => {
    // ELF-prefixed so the check gets PAST the header guard and actually
    // exercises the magic comparison: 'A' matches, 'p' does not.
    const buf = Buffer.alloc(64);
    buf.write('\x7fELF', 0, 'latin1');
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
  const bat = buildInstallerBat({
    pid: 4321,
    installer: 'C:\\u\\setup.exe',
    target: 'C:\\Users\\dev\\AppData\\Local\\Programs\\DevBar\\DevBar.exe',
  });
  it('waits for the old pid before launching the installer', () => {
    const wait = bat.indexOf('tasklist /fi "PID eq 4321"');
    const run = bat.indexOf('"C:\\u\\setup.exe" /S');
    expect(wait).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(run);
  });
  it('gives up instead of installing over a stuck process', () => {
    expect(bat).toContain('if %tries% geq 150 (');
    expect(bat).toContain('giving up: old pid still present');
  });
  it('traces its progress to install.log (silent NSIS failures are the failure mode)', () => {
    expect(bat).toContain('set "log=%~dp0install.log"');
    expect(bat).toContain('installer done, relaunching app');
  });
  it('checks the pid without a pipe and retries the installer once on failure', () => {
    expect(bat).toContain(
      'findstr /i "DevBar" "%~dp0devbar-pid.tmp" >nul 2>&1',
    );
    expect(bat).not.toContain('| find');
    expect(bat.match(/"C:\\u\\setup\.exe" \/S/g)).toHaveLength(2);
  });
  it('relaunches the app itself after a successful install (the installer does not, in this context)', () => {
    const install = bat.lastIndexOf('"C:\\u\\setup.exe" /S');
    const relaunch = bat.indexOf('start "" "%target%"');
    expect(relaunch).toBeGreaterThan(-1);
    expect(relaunch).toBeGreaterThan(install);
  });
  it('does not relaunch when the installer failed', () => {
    const failedLine = bat.indexOf('installer FAILED with code %errorlevel%');
    const giveUp = bat.indexOf('exit /b 1', failedLine);
    expect(failedLine).toBeGreaterThan(-1);
    expect(giveUp).toBeGreaterThan(failedLine);
    expect(bat.indexOf('start "" "%target%"')).toBeGreaterThan(giveUp);
  });
  it('passes the relaunch args through the start line', () => {
    const withArgs = buildInstallerBat({
      pid: 1,
      installer: 'C:\\u\\setup.exe',
      target: 'C:\\p\\DevBar.exe',
      relaunchArgs: ['--devbar-smoke'],
    });
    expect(withArgs).toContain('start "" "%target%" "--devbar-smoke"');
  });
  it('writes the success marker only on the installer+relaunch success path', () => {
    // No markerPath → no marker line at all.
    expect(bat).not.toContain('echo ok>');
    const withMarker = buildInstallerBat({
      pid: 1,
      installer: 'C:\\u\\setup.exe',
      target: 'C:\\p\\DevBar.exe',
      markerPath: 'C:\\work\\install-ok',
    });
    const marker = withMarker.indexOf('echo ok> "C:\\work\\install-ok"');
    const relaunch = withMarker.indexOf('start "" "%target%"');
    const failExit = withMarker.indexOf(
      'exit /b 1',
      withMarker.indexOf('installer FAILED'),
    );
    expect(marker).toBeGreaterThan(-1);
    // After the relaunch…
    expect(marker).toBeGreaterThan(relaunch);
    // …and only AFTER the installer-failure exit (a failed install must
    // not mark success).
    expect(marker).toBeGreaterThan(failExit);
  });
});
