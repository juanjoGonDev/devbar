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
import type { AvailableUpdate, StagedUpdate } from '../src/domain-types.js';

/**
 * `src/self-update.ts` is a FACADE: given the platform and the shape of the
 * install, it picks which artifact to download, whether an in-place update is
 * possible at all, and which per-platform swap mechanism to launch. What it
 * owns is the routing — the platform modules' own behaviour is pinned in
 * `tests/self-update.test.ts`, against the real implementations.
 *
 * Which is exactly why those three modules are MOCKED here, in a file of
 * their own: the win/linux branches cannot run on a macOS runner (and vice
 * versa), and the swap paths end in a detached process that would really
 * replace an application bundle. With the modules faked, every branch is
 * reachable on every runner and nothing leaves the test.
 */
type Recorded = [name: string, payload: unknown];

const mocks = vi.hoisted(() => ({
  calls: [] as Recorded[],
  macBundlePath: null as string | null,
  macCanInstall: true,
  linuxAppImagePath: null as string | null,
  linuxCanInstall: true,
  isInstalledExe: false,
  isUnderProgramFiles: false,
  isUnderTempDir: false,
  portableContainer: null as string | null,
}));

vi.mock('../src/self-update-macos.js', () => ({
  bundlePathFromExecutable: (execPath: string) => {
    mocks.calls.push(['mac.bundlePathFromExecutable', execPath]);
    return mocks.macBundlePath;
  },
  canInstallInPlace: (bundle: string | null) => {
    mocks.calls.push(['mac.canInstallInPlace', bundle]);
    return mocks.macCanInstall;
  },
  extractUpdate: (options: unknown) => {
    mocks.calls.push(['mac.extractUpdate', options]);
    return Promise.resolve({
      version: (options as { version: string }).version,
      appPath: '/staged/DevBar.app',
    } satisfies StagedUpdate);
  },
  buildSwapScript: () => '#!/bin/bash\n',
  spawnSwap: (options: unknown) => {
    mocks.calls.push(['mac.spawnSwap', options]);
  },
}));

vi.mock('../src/self-update-linux.js', () => ({
  appImagePathFromExecutable: (execPath: string) => {
    mocks.calls.push(['linux.appImagePathFromExecutable', execPath]);
    return mocks.linuxAppImagePath;
  },
  canInstallInPlace: (appImage: string | null) => {
    mocks.calls.push(['linux.canInstallInPlace', appImage]);
    return mocks.linuxCanInstall;
  },
  looksLikeAppImage: () => true,
  stageAppImage: (options: unknown) => {
    mocks.calls.push(['linux.stageAppImage', options]);
    return '/staged/DevBar.AppImage';
  },
  buildSwapScript: () => '#!/bin/bash\n',
  spawnSwap: (options: unknown) => {
    mocks.calls.push(['linux.spawnSwap', options]);
  },
}));

vi.mock('../src/self-update-windows.js', () => ({
  isInstalledExe: (installed: string, localAppData: string) => {
    mocks.calls.push(['win.isInstalledExe', [installed, localAppData]]);
    return mocks.isInstalledExe;
  },
  isUnderProgramFiles: (candidate: string) => {
    mocks.calls.push(['win.isUnderProgramFiles', candidate]);
    return mocks.isUnderProgramFiles;
  },
  isPortableContainer: () => false,
  isUnderTempDir: (execPath: string) => {
    mocks.calls.push(['win.isUnderTempDir', execPath]);
    return mocks.isUnderTempDir;
  },
  portableContainerPath: (execPath: string) => {
    mocks.calls.push(['win.portableContainerPath', execPath]);
    return mocks.portableContainer;
  },
  stageWindowsArtifact: (options: unknown) => {
    mocks.calls.push(['win.stageWindowsArtifact', options]);
    return 'C:\\staged\\DevBar-setup.exe';
  },
  buildSwapBat: () => '@echo off\n',
  buildInstallerBat: () => '@echo off\n',
  spawnSwapBat: (options: unknown) => {
    mocks.calls.push(['win.spawnSwapBat', options]);
  },
  spawnInstallerBat: (options: unknown) => {
    mocks.calls.push(['win.spawnInstallerBat', options]);
  },
}));

type Facade = typeof import('../src/self-update.js');

/**
 * Re-import with a faked `process.platform`: `isMac`/`isLinux`/`isWin` are
 * read at module load (src/platform.ts), so the branch is chosen at import.
 */
async function facadeFor(platform: NodeJS.Platform): Promise<Facade> {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  return import('../src/self-update.js');
}

function calls(name: string): unknown[] {
  return mocks.calls
    .filter(([called]) => called === name)
    .map(([, payload]) => payload);
}

function update(patch: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    version: '1.2.3',
    url: 'https://github.com/o/r/releases/tag/v1.2.3',
    dmgUrl: null,
    zipUrl: null,
    setupUrl: null,
    appImageUrl: null,
    debUrl: null,
    ...patch,
  };
}

/** A staged artifact, whatever the platform calls it. */
const STAGED: StagedUpdate = { version: '1.2.3', appPath: '/staged/DevBar' };

const PAYLOAD = 'devbar-update-payload';
/** sha256 of PAYLOAD, written out rather than recomputed: a hash the test
 *  derives with the same call the code makes would pass on any algorithm. */
const PAYLOAD_SHA256 =
  'a966d599c39abc85ecb1542233810fae7f306a897cb1f1f6bb6d91fbac01d13a';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-facade-'));
  tempDirs.push(dir);
  return dir;
}

describe('src/self-update.ts', () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.macBundlePath = '/Applications/DevBar.app';
    mocks.macCanInstall = true;
    mocks.linuxAppImagePath = '/home/u/Apps/DevBar.AppImage';
    mocks.linuxCanInstall = true;
    mocks.isInstalledExe = false;
    mocks.isUnderProgramFiles = false;
    mocks.isUnderTempDir = false;
    mocks.portableContainer = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (process as { defaultApp?: boolean }).defaultApp;
  });

  afterAll(() => {
    for (const dir of tempDirs)
      fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('installedAppPath', () => {
    it('has nothing to replace during a dev run', async () => {
      // `electron .` runs the binary out of node_modules; swapping it would
      // replace the dependency, not the user's installed app.
      const facade = await facadeFor('darwin');
      Object.defineProperty(process, 'defaultApp', {
        configurable: true,
        value: true,
      });
      expect(facade.installedAppPath()).toBeNull();
      expect(calls('mac.bundlePathFromExecutable')).toEqual([]);
    });

    it('resolves the .app bundle around the executable on macOS', async () => {
      const facade = await facadeFor('darwin');
      expect(facade.installedAppPath()).toBe('/Applications/DevBar.app');
      expect(calls('mac.bundlePathFromExecutable')).toEqual([process.execPath]);
    });

    it('resolves the running image on Linux', async () => {
      const facade = await facadeFor('linux');
      expect(facade.installedAppPath()).toBe('/home/u/Apps/DevBar.AppImage');
      expect(calls('linux.appImagePathFromExecutable')).toEqual([
        process.execPath,
      ]);
    });

    it('prefers the portable stub over the temp payload on Windows', async () => {
      // A running portable app executes an ephemeral copy the NSIS stub
      // extracted; swapping THAT would vanish with the temp dir.
      mocks.portableContainer = 'D:\\Tools\\DevBar.exe';
      const facade = await facadeFor('win32');
      expect(facade.installedAppPath()).toBe('D:\\Tools\\DevBar.exe');
    });

    it('refuses a Windows temp payload whose stub could not be resolved', async () => {
      mocks.isUnderTempDir = true;
      const facade = await facadeFor('win32');
      expect(facade.installedAppPath()).toBeNull();
    });

    it('falls back to the executable for a normal Windows install', async () => {
      const facade = await facadeFor('win32');
      expect(facade.installedAppPath()).toBe(process.execPath);
    });

    it('falls back to the executable on a platform it knows nothing about', async () => {
      const facade = await facadeFor('freebsd');
      expect(facade.installedAppPath()).toBe(process.execPath);
    });
  });

  describe('canInstallInPlace', () => {
    it('asks the Linux module about an AppImage', async () => {
      const facade = await facadeFor('linux');
      expect(facade.canInstallInPlace('/home/u/DevBar.AppImage')).toBe(true);
      mocks.linuxCanInstall = false;
      expect(facade.canInstallInPlace('/home/u/DevBar.AppImage')).toBe(false);
    });

    it('refuses an unsupported platform instead of falling through to Windows', async () => {
      // The fallback would select a Windows artifact and .bat swap logic the
      // system cannot run.
      const facade = await facadeFor('freebsd');
      expect(facade.canInstallInPlace('/opt/devbar/DevBar')).toBe(false);
    });

    it('accepts an NSIS per-user Windows install', async () => {
      mocks.isInstalledExe = true;
      const facade = await facadeFor('win32');
      expect(
        facade.canInstallInPlace('C:\\Users\\u\\AppData\\DevBar.exe'),
      ).toBe(true);
    });

    it('refuses a Program Files install, which would need elevation', async () => {
      mocks.isUnderProgramFiles = true;
      const facade = await facadeFor('win32');
      expect(
        facade.canInstallInPlace('C:\\Program Files\\DevBar\\DevBar.exe'),
      ).toBe(false);
    });
  });

  describe('stageableAsset', () => {
    it('has nothing to stage without an installed path', async () => {
      const facade = await facadeFor('darwin');
      expect(
        facade.stageableAsset(update({ zipUrl: 'https://x/a.zip' }), null),
      ).toBeNull();
    });

    it('has nothing to stage when an in-place update is impossible', async () => {
      mocks.macCanInstall = false;
      const facade = await facadeFor('darwin');
      expect(
        facade.stageableAsset(
          update({ zipUrl: 'https://x/a.zip' }),
          '/Applications/DevBar.app',
        ),
      ).toBeNull();
    });

    it('picks the release .zip on macOS and names it from the URL', async () => {
      const facade = await facadeFor('darwin');
      expect(
        facade.stageableAsset(
          update({
            zipUrl: 'https://x/download/DevBar-1.2.3-macos-arm64.zip?t=1',
          }),
          '/Applications/DevBar.app',
        ),
      ).toEqual({
        url: 'https://x/download/DevBar-1.2.3-macos-arm64.zip?t=1',
        fileName: 'DevBar-1.2.3-macos-arm64.zip',
        kind: 'macBundle',
      });
    });

    it('stages nothing on macOS when the release carries no .zip', async () => {
      const facade = await facadeFor('darwin');
      expect(
        facade.stageableAsset(update(), '/Applications/DevBar.app'),
      ).toBeNull();
    });

    it('picks the .AppImage on Linux', async () => {
      const facade = await facadeFor('linux');
      expect(
        facade.stageableAsset(
          update({ appImageUrl: 'https://x/DevBar-linux-x64.AppImage' }),
          '/home/u/DevBar.AppImage',
        ),
      ).toEqual({
        url: 'https://x/DevBar-linux-x64.AppImage',
        fileName: 'DevBar-linux-x64.AppImage',
        kind: 'appImage',
      });
    });

    it('stages nothing on Linux when the release carries no .AppImage', async () => {
      // A .deb install is not updatable in place; it uses the assisted flow.
      const facade = await facadeFor('linux');
      expect(
        facade.stageableAsset(
          update({ debUrl: 'https://x/DevBar.deb' }),
          '/home/u/DevBar.AppImage',
        ),
      ).toBeNull();
    });

    it('picks the installer for an NSIS Windows install', async () => {
      mocks.isInstalledExe = true;
      const facade = await facadeFor('win32');
      expect(
        facade.stageableAsset(
          update({ setupUrl: 'https://x/DevBar-win-x64-setup.exe' }),
          'C:\\Users\\u\\AppData\\DevBar.exe',
        ),
      ).toEqual({
        url: 'https://x/DevBar-win-x64-setup.exe',
        fileName: 'DevBar-win-x64-setup.exe',
        kind: 'winInstaller',
      });
    });

    it('stages nothing for an NSIS install whose release has no installer', async () => {
      mocks.isInstalledExe = true;
      const facade = await facadeFor('win32');
      expect(
        facade.stageableAsset(
          update({ zipUrl: 'https://x/DevBar-win-x64-portable.exe' }),
          'C:\\Users\\u\\AppData\\DevBar.exe',
        ),
      ).toBeNull();
    });

    it('picks the portable exe for a portable Windows install', async () => {
      const facade = await facadeFor('win32');
      expect(
        facade.stageableAsset(
          update({ zipUrl: 'https://x/DevBar-win-x64-portable.exe' }),
          'D:\\Tools\\DevBar.exe',
        ),
      ).toEqual({
        url: 'https://x/DevBar-win-x64-portable.exe',
        fileName: 'DevBar-win-x64-portable.exe',
        kind: 'winPortable',
      });
    });

    it('stages nothing for a portable install whose release has no portable exe', async () => {
      const facade = await facadeFor('win32');
      expect(
        facade.stageableAsset(
          update({ setupUrl: 'https://x/DevBar-win-x64-setup.exe' }),
          'D:\\Tools\\DevBar.exe',
        ),
      ).toBeNull();
    });
  });

  describe('verifySha256', () => {
    it('rejects a download the release manifest has no entry for', async () => {
      // No entry means no trust anchor at all for an unsigned download.
      const facade = await facadeFor('darwin');
      const file = path.join(tempDir(), 'artifact.bin');
      fs.writeFileSync(file, PAYLOAD);
      await expect(facade.verifySha256(file, undefined)).resolves.toBe(false);
    });

    it('accepts a file whose digest matches the manifest', async () => {
      const facade = await facadeFor('darwin');
      const file = path.join(tempDir(), 'artifact.bin');
      fs.writeFileSync(file, PAYLOAD);
      await expect(facade.verifySha256(file, PAYLOAD_SHA256)).resolves.toBe(
        true,
      );
    });

    it('compares the digest case-insensitively', async () => {
      const facade = await facadeFor('darwin');
      const file = path.join(tempDir(), 'artifact.bin');
      fs.writeFileSync(file, PAYLOAD);
      await expect(
        facade.verifySha256(file, PAYLOAD_SHA256.toUpperCase()),
      ).resolves.toBe(true);
    });

    it('rejects a file that does not hash to the expected digest', async () => {
      const facade = await facadeFor('darwin');
      const file = path.join(tempDir(), 'artifact.bin');
      fs.writeFileSync(file, `${PAYLOAD} tampered`);
      await expect(facade.verifySha256(file, PAYLOAD_SHA256)).resolves.toBe(
        false,
      );
    });

    it('surfaces a read failure instead of reporting a match', async () => {
      const facade = await facadeFor('darwin');
      await expect(
        facade.verifySha256(
          path.join(tempDir(), 'missing.bin'),
          PAYLOAD_SHA256,
        ),
      ).rejects.toThrow(/ENOENT/);
    });
  });

  describe('stageDownloadedArtifact', () => {
    it('unpacks a macOS .zip into the staging dir', async () => {
      const facade = await facadeFor('darwin');
      await expect(
        facade.stageDownloadedArtifact({
          filePath: '/dl/DevBar.zip',
          destDir: '/stage/1.2.3',
          version: '1.2.3',
          kind: 'macBundle',
        }),
      ).resolves.toEqual({ version: '1.2.3', appPath: '/staged/DevBar.app' });
      expect(calls('mac.extractUpdate')).toEqual([
        {
          zipPath: '/dl/DevBar.zip',
          destDir: '/stage/1.2.3',
          version: '1.2.3',
        },
      ]);
    });

    it('stages an AppImage under its own file name', async () => {
      const facade = await facadeFor('linux');
      await expect(
        facade.stageDownloadedArtifact({
          filePath: '/dl/DevBar-linux-x64.AppImage',
          destDir: '/stage/1.2.3',
          version: '1.2.3',
          kind: 'appImage',
        }),
      ).resolves.toEqual({
        version: '1.2.3',
        appPath: '/staged/DevBar.AppImage',
      });
      expect(calls('linux.stageAppImage')).toEqual([
        {
          filePath: '/dl/DevBar-linux-x64.AppImage',
          destDir: '/stage/1.2.3',
          fileName: 'DevBar-linux-x64.AppImage',
        },
      ]);
    });

    it('stages a Windows installer', async () => {
      const facade = await facadeFor('win32');
      await expect(
        facade.stageDownloadedArtifact({
          filePath: '/dl/DevBar-setup.exe',
          destDir: '/stage/1.2.3',
          version: '1.2.3',
          kind: 'winInstaller',
        }),
      ).resolves.toEqual({
        version: '1.2.3',
        appPath: 'C:\\staged\\DevBar-setup.exe',
      });
      expect(calls('win.stageWindowsArtifact')).toHaveLength(1);
    });

    it('stages a Windows portable exe the same way', async () => {
      const facade = await facadeFor('win32');
      await expect(
        facade.stageDownloadedArtifact({
          filePath: '/dl/DevBar-portable.exe',
          destDir: '/stage/1.2.3',
          version: '1.2.3',
          kind: 'winPortable',
        }),
      ).resolves.toEqual({
        version: '1.2.3',
        appPath: 'C:\\staged\\DevBar-setup.exe',
      });
      expect(calls('win.stageWindowsArtifact')).toEqual([
        {
          filePath: '/dl/DevBar-portable.exe',
          destDir: '/stage/1.2.3',
          fileName: 'DevBar-portable.exe',
        },
      ]);
    });
  });

  describe('spawnSwap', () => {
    it('writes the macOS swap script into a directory it creates', async () => {
      const facade = await facadeFor('darwin');
      const scriptDir = path.join(tempDir(), 'nested', 'scripts');
      facade.spawnSwap({
        staged: STAGED,
        target: '/Applications/DevBar.app',
        scriptDir,
        pid: 4321,
        relaunchArgs: ['--devbar-smoke'],
        markerPath: '/tmp/marker',
      });
      expect(fs.existsSync(scriptDir)).toBe(true);
      expect(calls('mac.spawnSwap')).toEqual([
        {
          scriptPath: path.join(scriptDir, 'swap.sh'),
          pid: 4321,
          target: '/Applications/DevBar.app',
          staged: '/staged/DevBar',
          relaunchArgs: ['--devbar-smoke'],
          markerPath: '/tmp/marker',
        },
      ]);
    });

    it('uses the Linux swap script on Linux', async () => {
      const facade = await facadeFor('linux');
      const scriptDir = tempDir();
      facade.spawnSwap({
        staged: STAGED,
        target: '/home/u/DevBar.AppImage',
        scriptDir,
        pid: 7,
      });
      expect(calls('linux.spawnSwap')).toEqual([
        {
          scriptPath: path.join(scriptDir, 'swap.sh'),
          pid: 7,
          target: '/home/u/DevBar.AppImage',
          staged: '/staged/DevBar',
          relaunchArgs: undefined,
          markerPath: undefined,
        },
      ]);
    });

    it('runs the installer after quitting for an NSIS install', async () => {
      // The installer replacing a locked exe is the most common way a Windows
      // update half-resolves, so the .bat waits for our exit first — and owns
      // the relaunch, which the installer's own "run after finish" will not do
      // in this hidden detached context.
      mocks.isInstalledExe = true;
      const facade = await facadeFor('win32');
      const scriptDir = tempDir();
      facade.spawnSwap({
        staged: STAGED,
        target: 'C:\\Users\\u\\AppData\\DevBar.exe',
        scriptDir,
        pid: 11,
        relaunchArgs: null,
        markerPath: null,
      });
      expect(calls('win.spawnInstallerBat')).toEqual([
        {
          scriptPath: path.join(scriptDir, 'install.bat'),
          pid: 11,
          installer: '/staged/DevBar',
          target: 'C:\\Users\\u\\AppData\\DevBar.exe',
          relaunchArgs: null,
          markerPath: null,
        },
      ]);
      expect(calls('win.spawnSwapBat')).toEqual([]);
    });

    it('swaps the file itself for a portable install', async () => {
      const facade = await facadeFor('win32');
      const scriptDir = tempDir();
      facade.spawnSwap({
        staged: STAGED,
        target: 'D:\\Tools\\DevBar.exe',
        scriptDir,
        pid: 12,
      });
      expect(calls('win.spawnSwapBat')).toEqual([
        {
          scriptPath: path.join(scriptDir, 'swap.bat'),
          pid: 12,
          target: 'D:\\Tools\\DevBar.exe',
          staged: '/staged/DevBar',
          relaunchArgs: undefined,
          markerPath: undefined,
        },
      ]);
      expect(calls('win.spawnInstallerBat')).toEqual([]);
    });

    it('refuses to orchestrate a swap on a platform it does not support', async () => {
      // Defense in depth: stageableAsset already returns null there, but
      // falling through would write a .bat and taskkill calls on a non-Windows
      // host.
      const facade = await facadeFor('freebsd');
      expect(() =>
        facade.spawnSwap({
          staged: STAGED,
          target: '/opt/devbar/DevBar',
          scriptDir: tempDir(),
          pid: 1,
        }),
      ).toThrow('in-place update is not supported on freebsd');
    });
  });
});
