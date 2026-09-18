import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The parts of the three platform updaters that touch the filesystem or hand
 * work to another process: unpacking/staging a download, and writing + running
 * the detached swap script.
 *
 * `node:child_process` is mocked for the whole file. That is the point:
 * `spawnSwap` ends in a detached process whose whole job is to REPLACE THE
 * INSTALLED APPLICATION, and `extractUpdate` shells out to macOS-only tools.
 * Faking the process boundary keeps every branch reachable on every runner
 * and keeps the swap inside the test. Everything below the boundary — the
 * files written, their modes, the argv — is real and asserted.
 */
interface Spawned {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

interface Recorded {
  file: string;
  args: readonly string[];
}

const mocks = vi.hoisted(
  (): {
    spawned: Spawned[];
    /** `file` → what running it should produce (or throw). */
    handlers: Record<string, (args: readonly string[]) => string>;
    execFileCalls: Recorded[];
    syncCalls: Recorded[];
    /** What the mocked `execFileSync` returns, or an Error it throws. */
    syncResult: string | Error;
  } => ({
    spawned: [],
    handlers: {},
    execFileCalls: [],
    syncCalls: [],
    syncResult: '',
  }),
);

vi.mock('node:child_process', () => ({
  spawn: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    mocks.spawned.push({ file, args, options });
    return { unref: () => undefined };
  },
  execFile: (
    file: string,
    args: readonly string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    mocks.execFileCalls.push({ file, args });
    const handler = mocks.handlers[file];
    if (!handler) {
      callback(new Error(`no handler for ${file}`), '', '');
      return {};
    }
    try {
      callback(null, handler(args), '');
    } catch (error) {
      callback(error as Error, '', '');
    }
    return {};
  },
  execFileSync: (file: string, args: readonly string[]) => {
    mocks.syncCalls.push({ file, args });
    if (mocks.syncResult instanceof Error) throw mocks.syncResult;
    return mocks.syncResult;
  },
}));

const { extractUpdate, spawnSwap: macSpawnSwap } =
  await import('../src/self-update-macos.js');
const { stageAppImage, spawnSwap: linuxSpawnSwap } =
  await import('../src/self-update-linux.js');
const {
  portableContainerPath,
  spawnInstallerBat,
  spawnSwapBat,
  stageWindowsArtifact,
} = await import('../src/self-update-windows.js');

const tempDirs: string[] = [];
function tempDir(prefix = 'devbar-staging-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** ELF header plus the AppImageSpec "AI" + type-2 magic at offset 8. */
function writeAppImage(filePath: string): string {
  const buffer = Buffer.alloc(32);
  buffer.write('\x7fELF', 0, 'latin1');
  buffer[8] = 0x41;
  buffer[9] = 0x49;
  buffer[10] = 0x02;
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/** The two-byte MZ header every Windows PE file carries. */
function writeWindowsExe(filePath: string): string {
  fs.writeFileSync(filePath, Buffer.from('MZ payload', 'latin1'));
  return filePath;
}

function isOwnerExecutable(filePath: string): boolean {
  // Not an exact mode compare: `writeFileSync(..., { mode })` is masked by the
  // contributor's umask, so only the bit that matters is asserted.
  return (fs.statSync(filePath).mode & 0o100) !== 0;
}

describe('platform updaters — staging and swap launch', () => {
  beforeEach(() => {
    mocks.spawned.length = 0;
    mocks.execFileCalls.length = 0;
    mocks.syncCalls.length = 0;
    mocks.handlers = {};
    mocks.syncResult = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const dir of tempDirs)
      fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('src/self-update-macos.ts — extractUpdate', () => {
    /** Makes the faked `ditto` unpack `layout` into the destination dir. */
    function dittoWrites(layout: (destDir: string) => void): void {
      mocks.handlers['/usr/bin/ditto'] = (args) => {
        const destDir = args[3];
        if (!destDir) throw new Error('ditto got no destination');
        layout(destDir);
        return '';
      };
    }

    function withBundle(version = '1.2.3'): void {
      dittoWrites((destDir) => {
        const app = path.join(destDir, 'DevBar.app', 'Contents');
        fs.mkdirSync(app, { recursive: true });
        fs.writeFileSync(path.join(app, 'Info.plist'), '<plist/>');
      });
      mocks.handlers['/usr/libexec/PlistBuddy'] = () => version;
      mocks.handlers['/usr/bin/codesign'] = () => '';
    }

    it('hands back the unpacked bundle once every check passes', async () => {
      withBundle();
      const destDir = path.join(tempDir(), 'stage', '1.2.3');
      await expect(
        extractUpdate({ zipPath: '/dl/DevBar.zip', destDir, version: '1.2.3' }),
      ).resolves.toEqual({
        version: '1.2.3',
        appPath: path.join(destDir, 'DevBar.app'),
      });
      expect(mocks.execFileCalls.map((call) => call.file)).toEqual([
        '/usr/bin/ditto',
        '/usr/libexec/PlistBuddy',
        '/usr/bin/codesign',
      ]);
    });

    it('clears whatever a previous attempt left in the staging dir', async () => {
      withBundle();
      const destDir = path.join(tempDir(), 'stage');
      fs.mkdirSync(destDir, { recursive: true });
      const stale = path.join(destDir, 'half-written.app');
      fs.writeFileSync(stale, 'junk');
      await extractUpdate({
        zipPath: '/dl/DevBar.zip',
        destDir,
        version: '1.2.3',
      });
      expect(fs.existsSync(stale)).toBe(false);
    });

    it('refuses an archive that carries no .app at all', async () => {
      dittoWrites((destDir) => {
        fs.writeFileSync(path.join(destDir, 'README.txt'), 'nope');
      });
      await expect(
        extractUpdate({
          zipPath: '/dl/DevBar.zip',
          destDir: path.join(tempDir(), 'stage'),
          version: '1.2.3',
        }),
      ).rejects.toThrow('el archivo no contiene ninguna .app');
    });

    it('refuses a bundle with no Info.plist', async () => {
      dittoWrites((destDir) => {
        fs.mkdirSync(path.join(destDir, 'DevBar.app', 'Contents'), {
          recursive: true,
        });
      });
      await expect(
        extractUpdate({
          zipPath: '/dl/DevBar.zip',
          destDir: path.join(tempDir(), 'stage'),
          version: '1.2.3',
        }),
      ).rejects.toThrow('la .app descargada no tiene Info.plist');
    });

    it('refuses a bundle that is not the version we asked for', async () => {
      withBundle('9.9.9');
      await expect(
        extractUpdate({
          zipPath: '/dl/DevBar.zip',
          destDir: path.join(tempDir(), 'stage'),
          version: '1.2.3',
        }),
      ).rejects.toThrow('la descarga dice v9.9.9, se esperaba v1.2.3');
    });

    it('refuses a bundle whose signature does not verify', async () => {
      // The seal covers every file in the bundle: a truncated or partially
      // rewritten download must fail HERE, not at the swap.
      withBundle();
      mocks.handlers['/usr/bin/codesign'] = () => {
        throw new Error('code object is not signed at all');
      };
      await expect(
        extractUpdate({
          zipPath: '/dl/DevBar.zip',
          destDir: path.join(tempDir(), 'stage'),
          version: '1.2.3',
        }),
      ).rejects.toThrow('code object is not signed at all');
    });

    it('surfaces a failed unpack instead of reporting an empty archive', async () => {
      mocks.handlers['/usr/bin/ditto'] = () => {
        throw new Error('ditto: Invalid archive');
      };
      await expect(
        extractUpdate({
          zipPath: '/dl/DevBar.zip',
          destDir: path.join(tempDir(), 'stage'),
          version: '1.2.3',
        }),
      ).rejects.toThrow('ditto: Invalid archive');
    });
  });

  describe('src/self-update-macos.ts — spawnSwap', () => {
    it('writes an executable script and launches it detached', () => {
      const scriptPath = path.join(tempDir(), 'nested', 'swap.sh');
      macSpawnSwap({
        scriptPath,
        pid: 4321,
        target: '/Applications/DevBar.app',
        staged: '/stage/DevBar.app',
      });
      expect(fs.readFileSync(scriptPath, 'utf8')).toContain('kill -0 4321');
      expect(isOwnerExecutable(scriptPath)).toBe(true);
      // Detached with no stdio: the app quits right after, and the script has
      // to outlive it.
      expect(mocks.spawned).toEqual([
        {
          file: '/bin/bash',
          args: [scriptPath],
          options: { detached: true, stdio: 'ignore' },
        },
      ]);
    });
  });

  describe('src/self-update-linux.ts — stageAppImage', () => {
    it('places the download in the staging dir and makes it runnable', () => {
      const source = writeAppImage(path.join(tempDir(), 'download.bin'));
      const destDir = path.join(tempDir(), 'stage', '1.2.3');
      const staged = stageAppImage({
        filePath: source,
        destDir,
        fileName: 'DevBar-1.2.3.AppImage',
      });
      expect(staged).toBe(path.join(destDir, 'DevBar-1.2.3.AppImage'));
      expect(fs.readFileSync(staged)).toEqual(fs.readFileSync(source));
      // An AppImage that is not executable cannot be relaunched after the swap.
      expect(isOwnerExecutable(staged)).toBe(true);
    });

    it('clears whatever a previous attempt left in the staging dir', () => {
      const source = writeAppImage(path.join(tempDir(), 'download.bin'));
      const destDir = path.join(tempDir(), 'stage');
      fs.mkdirSync(destDir, { recursive: true });
      const stale = path.join(destDir, 'old.AppImage');
      fs.writeFileSync(stale, 'junk');
      stageAppImage({ filePath: source, destDir, fileName: 'new.AppImage' });
      expect(fs.existsSync(stale)).toBe(false);
    });

    it('refuses a download that is not an AppImage', () => {
      const source = path.join(tempDir(), 'download.bin');
      fs.writeFileSync(source, 'this is an HTML error page, not an image');
      expect(() =>
        stageAppImage({
          filePath: source,
          destDir: path.join(tempDir(), 'stage'),
          fileName: 'DevBar.AppImage',
        }),
      ).toThrow('la descarga no parece un AppImage válido');
    });
  });

  describe('src/self-update-linux.ts — spawnSwap', () => {
    it('writes an executable script and launches it detached', () => {
      const scriptPath = path.join(tempDir(), 'nested', 'swap.sh');
      linuxSpawnSwap({
        scriptPath,
        pid: 99,
        target: '/home/u/DevBar.AppImage',
        staged: '/stage/DevBar.AppImage',
        relaunchArgs: ['--devbar-smoke'],
        markerPath: null,
      });
      const script = fs.readFileSync(scriptPath, 'utf8');
      expect(script).toContain('kill -0 99');
      expect(script).toContain('--devbar-smoke');
      expect(isOwnerExecutable(scriptPath)).toBe(true);
      expect(mocks.spawned).toEqual([
        {
          file: '/bin/bash',
          args: [scriptPath],
          options: { detached: true, stdio: 'ignore' },
        },
      ]);
    });
  });

  describe('src/self-update-windows.ts — stageWindowsArtifact', () => {
    it('places the download in the staging dir under its own name', () => {
      const source = writeWindowsExe(path.join(tempDir(), 'download.bin'));
      const destDir = path.join(tempDir(), 'stage', '1.2.3');
      const staged = stageWindowsArtifact({
        filePath: source,
        destDir,
        fileName: 'DevBar-setup.exe',
      });
      expect(staged).toBe(path.join(destDir, 'DevBar-setup.exe'));
      expect(fs.readFileSync(staged)).toEqual(fs.readFileSync(source));
    });

    it('clears whatever a previous attempt left in the staging dir', () => {
      const source = writeWindowsExe(path.join(tempDir(), 'download.bin'));
      const destDir = path.join(tempDir(), 'stage');
      fs.mkdirSync(destDir, { recursive: true });
      const stale = path.join(destDir, 'old-setup.exe');
      fs.writeFileSync(stale, 'junk');
      stageWindowsArtifact({
        filePath: source,
        destDir,
        fileName: 'new-setup.exe',
      });
      expect(fs.existsSync(stale)).toBe(false);
    });

    it('refuses a download that is not a Windows executable', () => {
      const source = path.join(tempDir(), 'download.bin');
      fs.writeFileSync(source, 'this is an HTML error page, not an exe');
      expect(() =>
        stageWindowsArtifact({
          filePath: source,
          destDir: path.join(tempDir(), 'stage'),
          fileName: 'DevBar-setup.exe',
        }),
      ).toThrow('la descarga no parece un ejecutable de Windows válido');
    });
  });

  describe('src/self-update-windows.ts — launching a bat', () => {
    it('writes the swap bat and runs it through the command processor', () => {
      vi.stubEnv('COMSPEC', 'C:\\Windows\\system32\\cmd.exe');
      const scriptPath = path.join(tempDir(), 'nested', 'swap.bat');
      spawnSwapBat({
        scriptPath,
        pid: 11,
        target: 'D:\\Tools\\DevBar.exe',
        staged: 'D:\\stage\\DevBar.exe',
      });
      expect(fs.readFileSync(scriptPath, 'utf8')).toContain('11');
      expect(mocks.spawned).toEqual([
        {
          file: 'C:\\Windows\\system32\\cmd.exe',
          args: ['/d', '/c', scriptPath],
          options: { detached: true, stdio: 'ignore', windowsHide: true },
        },
      ]);
      vi.unstubAllEnvs();
    });

    it('writes the installer bat and runs it the same way', () => {
      vi.stubEnv('COMSPEC', 'C:\\Windows\\system32\\cmd.exe');
      const scriptPath = path.join(tempDir(), 'install.bat');
      spawnInstallerBat({
        scriptPath,
        pid: 12,
        installer: 'D:\\stage\\DevBar-setup.exe',
        target: 'C:\\Users\\u\\AppData\\DevBar.exe',
      });
      expect(fs.readFileSync(scriptPath, 'utf8')).toContain('DevBar-setup.exe');
      expect(mocks.spawned[0]?.args).toEqual(['/d', '/c', scriptPath]);
      vi.unstubAllEnvs();
    });

    it('falls back to cmd.exe when COMSPEC is empty', () => {
      // `||`, not `??`: an empty COMSPEC would reach spawn('') and the bat
      // would never launch — with the app quitting right after, the user is
      // left with no update and no relaunch.
      vi.stubEnv('COMSPEC', '');
      spawnSwapBat({
        scriptPath: path.join(tempDir(), 'swap.bat'),
        pid: 13,
        target: 'D:\\Tools\\DevBar.exe',
        staged: 'D:\\stage\\DevBar.exe',
      });
      expect(mocks.spawned[0]?.file).toBe('cmd.exe');
      vi.unstubAllEnvs();
    });
  });

  describe('src/self-update-windows.ts — portableContainerPath', () => {
    /** A distinct temp payload per case: the answer is cached per execPath. */
    function payloadPath(name: string): string {
      return path.join(tempDir(`devbar-portable-${name}-`), 'DevBar.exe');
    }

    it('is not a Windows question at all off Windows', () => {
      expect(portableContainerPath(payloadPath('offwin'))).toBeNull();
      expect(mocks.syncCalls).toEqual([]);
    });

    it('never queries the parent process for a non-temp executable', () => {
      // Only a payload extracted under the temp dir can be a portable
      // instance; everything else short-circuits before spawning powershell.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      expect(
        portableContainerPath('C:\\Users\\u\\AppData\\Programs\\DevBar.exe'),
      ).toBeNull();
      expect(mocks.syncCalls).toEqual([]);
    });

    it('resolves the stub that extracted this payload', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const stub = writeWindowsExe(
        path.join(tempDir('devbar-stub-'), 'DevBar-portable.exe'),
      );
      mocks.syncResult = `\r\n${stub}\r\n`;
      expect(portableContainerPath(payloadPath('ok'))).toBe(stub);
      expect(mocks.syncCalls[0]?.file).toBe('powershell.exe');
    });

    it('answers from cache instead of querying twice', () => {
      // Resolved once per process: the answer is stable for the app's lifetime.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const stub = writeWindowsExe(
        path.join(tempDir('devbar-stub2-'), 'DevBar-portable.exe'),
      );
      mocks.syncResult = stub;
      const execPath = payloadPath('cached');
      expect(portableContainerPath(execPath)).toBe(stub);
      mocks.syncCalls.length = 0;
      expect(portableContainerPath(execPath)).toBe(stub);
      expect(mocks.syncCalls).toEqual([]);
    });

    it('refuses a parent that is not one of ours', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mocks.syncResult = 'C:\\Windows\\explorer.exe';
      expect(portableContainerPath(payloadPath('foreign'))).toBeNull();
    });

    it('refuses a devbar-named parent that is not a real executable', () => {
      // The name gate says "plausible"; only a real PE is a target for a swap.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const notAnExe = path.join(tempDir('devbar-fake-'), 'DevBar.exe');
      fs.writeFileSync(notAnExe, 'not a PE file');
      mocks.syncResult = notAnExe;
      expect(portableContainerPath(payloadPath('notpe'))).toBeNull();
    });

    it('degrades to null when the parent can no longer be queried', () => {
      // Fails closed: the caller then uses the assisted flow rather than
      // swapping an ephemeral copy that dies with the temp dir.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mocks.syncResult = new Error('the process has already exited');
      expect(portableContainerPath(payloadPath('gone'))).toBeNull();
    });

    it('degrades to null when the query returns nothing', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      mocks.syncResult = '\r\n   \r\n';
      expect(portableContainerPath(payloadPath('empty'))).toBeNull();
    });
  });
});
