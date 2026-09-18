import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseConfig,
  contractArchName,
  hostArch,
  linuxArchs,
  linuxBuildOptions,
  main,
  PACKAGE_USAGE,
  parsePackageArgs,
  runBuild,
  windowsArchs,
  windowsBuildOptions,
  type ElectronBuilderLike,
  type PackageMode,
  type PackageRuntime,
} from '../scripts/package-win-linux.js';

/**
 * The electron-builder orchestration for win/linux. These tests pin the
 * config objects handed to electron-builder — a wrong artifact name or a
 * missing platform flag only shows up as a broken release, hours later —
 * and they never run a real build.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
/** A fake checkout root, so the asserted paths are literal, not derived. */
const ROOT = path.join(path.sep, 'repo');
const VERSION = '9.9.9';
const BUILDER_ARCH_KEYS = ['x64', 'arm64', 'armv7l'];
const temporaryDirectories: string[] = [];

function winConfig(arch: string, mode: PackageMode) {
  return windowsBuildOptions({ arch, mode, version: VERSION, root: ROOT });
}

/** Collects the per-arch progress lines the build prints. */
function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    lines.push(String(message));
  });
  return lines;
}

function linuxConfig(arch: string, mode: PackageMode) {
  return linuxBuildOptions({ arch, mode, version: VERSION, root: ROOT });
}

describe('scripts/package-win-linux.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  describe('parsePackageArgs', () => {
    it('defaults the mode to the full multi-arch build', () => {
      expect(parsePackageArgs(['win'])).toEqual({
        target: 'win',
        mode: 'full',
      });
    });

    it('accepts the dir and host modes for both targets', () => {
      expect(parsePackageArgs(['linux', 'dir'])).toEqual({
        target: 'linux',
        mode: 'dir',
      });
      expect(parsePackageArgs(['win', 'host'])).toEqual({
        target: 'win',
        mode: 'host',
      });
    });

    it('rejects a target that is not win or linux', () => {
      expect(() => parsePackageArgs(['macos'])).toThrow(PACKAGE_USAGE);
      expect(() => parsePackageArgs([undefined])).toThrow(PACKAGE_USAGE);
      expect(() => parsePackageArgs([])).toThrow(PACKAGE_USAGE);
    });

    it('rejects a misspelled mode instead of starting the full build', () => {
      // The regression this guard exists for: with plain dirOnly/hostOnly
      // booleans, `hots` leaves both false and silently kicks off the FULL
      // multi-architecture build on a developer machine.
      expect(() => parsePackageArgs(['win', 'hots'])).toThrow(PACKAGE_USAGE);
      expect(() => parsePackageArgs(['linux', 'DIR'])).toThrow(PACKAGE_USAGE);
      expect(() => parsePackageArgs(['linux', ''])).toThrow(PACKAGE_USAGE);
    });
  });

  describe('hostArch', () => {
    it('maps the node arch onto the electron-builder arch key', () => {
      expect(hostArch('arm64')).toBe('arm64');
      expect(hostArch('arm')).toBe('armv7l');
      expect(hostArch('x64')).toBe('x64');
    });

    it('falls back to x64 for any other host', () => {
      expect(hostArch('ia32')).toBe('x64');
      expect(hostArch('ppc64')).toBe('x64');
    });

    it('reads process.arch when no architecture is given', () => {
      expect(hostArch()).toBe(hostArch(process.arch));
      expect(BUILDER_ARCH_KEYS).toContain(hostArch());
    });
  });

  describe('contractArchName', () => {
    it('renames only the 32-bit Pi arch', () => {
      expect(contractArchName('armv7l')).toBe('armv7');
      expect(contractArchName('arm64')).toBe('arm64');
      expect(contractArchName('x64')).toBe('x64');
    });
  });

  describe('windowsArchs / linuxArchs', () => {
    it('builds every arch of the release contract in full mode', () => {
      expect(windowsArchs('full')).toEqual(['x64', 'arm64']);
      expect(linuxArchs('full')).toEqual(['x64', 'arm64', 'armv7l']);
    });

    it('builds the host arch only in dir and host mode', () => {
      for (const mode of ['dir', 'host'] as const) {
        expect(windowsArchs(mode), `win ${mode}`).toHaveLength(1);
        expect(linuxArchs(mode), `linux ${mode}`).toHaveLength(1);
        expect(BUILDER_ARCH_KEYS, `linux ${mode}`).toContain(
          linuxArchs(mode)[0],
        );
      }
    });
  });

  describe('baseConfig', () => {
    it('ships only the built app, the assets and package.json', () => {
      expect(baseConfig()).toEqual({
        appId: 'io.github.juanjogondev.devbar',
        productName: 'DevBar',
        asar: true,
        publish: null,
        directories: { output: 'dist/electron-builder' },
        files: ['build/**/*', 'assets/**/*', 'package.json'],
      });
    });

    it('returns a fresh object per call', () => {
      // app-builder-lib mutates the config it receives: a shared instance
      // makes the SECOND per-arch invocation crash in normalizeFiles.
      const first = baseConfig();
      const second = baseConfig();
      expect(first).not.toBe(second);
      expect(first.files).not.toBe(second.files);
    });
  });

  describe('windowsBuildOptions', () => {
    it('forces the win platform and builds nsis + portable per arch', () => {
      expect(winConfig('arm64', 'full')).toEqual({
        win: [],
        config: {
          ...baseConfig(),
          win: {
            icon: path.join(ROOT, 'assets', 'icon.ico'),
            target: [
              { target: 'nsis', arch: ['arm64'] },
              { target: 'portable', arch: ['arm64'] },
            ],
          },
          nsis: {
            oneClick: true,
            perMachine: false,
            allowToChangeInstallationDirectory: false,
            deleteAppDataOnUninstall: false,
            artifactName: 'DevBar-9.9.9-win-arm64-setup.${ext}',
          },
          portable: {
            artifactName: 'DevBar-9.9.9-win-arm64-portable.${ext}',
          },
        },
      });
    });

    it('keeps the empty win platform list and never sets linux', () => {
      // An empty list forces the platform while leaving config.win.target in
      // charge; with NO flag electron-builder would build for the HOST, so a
      // `win` request from Linux/macOS would produce a Linux bundle.
      const options = winConfig('x64', 'full');
      expect(options.win).toEqual([]);
      expect(options.linux).toBeUndefined();
    });

    it('names the x64 installers after the version and arch', () => {
      const config = winConfig('x64', 'full').config;
      expect(config).toMatchObject({
        nsis: { artifactName: 'DevBar-9.9.9-win-x64-setup.${ext}' },
        portable: { artifactName: 'DevBar-9.9.9-win-x64-portable.${ext}' },
      });
    });

    it('collapses dir mode to a single unpacked host-arch target', () => {
      const config = winConfig('arm64', 'dir').config;
      const target = (config as { win: { target: unknown[] } }).win.target;
      expect(target).toHaveLength(1);
      expect(target[0]).toMatchObject({ target: 'dir' });
      expect(
        BUILDER_ARCH_KEYS.includes(
          (target[0] as { arch: string[] }).arch[0] ?? '',
        ),
        JSON.stringify(target[0]),
      ).toBe(true);
    });

    it('keeps the installers in host mode (only the arch list shrinks)', () => {
      const config = winConfig('x64', 'host').config;
      expect(config).toMatchObject({
        win: {
          target: [
            { target: 'nsis', arch: ['x64'] },
            { target: 'portable', arch: ['x64'] },
          ],
        },
      });
    });
  });

  describe('linuxBuildOptions', () => {
    it('forces the linux platform and builds AppImage + deb per arch', () => {
      expect(linuxConfig('x64', 'full')).toEqual({
        linux: [],
        config: {
          ...baseConfig(),
          linux: {
            icon: path.join(ROOT, 'buildResources', 'icons'),
            category: 'Development',
            maintainer: 'Juanjo González <juanjo96developer@gmail.com>',
            synopsis: 'Menu bar launcher for local development services',
            description:
              'Start and stop dev services, switch git branches per group, run actions and watch logs from the system tray.',
            target: [
              { target: 'AppImage', arch: ['x64'] },
              { target: 'deb', arch: ['x64'] },
            ],
            artifactName: 'DevBar-9.9.9-linux-x64.${ext}',
          },
        },
      });
    });

    it('targets armv7l but names the artifact armv7 (the contract name)', () => {
      // electron-builder's arch key and the release artifact contract
      // disagree on this one arch; the updater downloads by contract name.
      expect(linuxConfig('armv7l', 'full').config).toMatchObject({
        linux: {
          target: [
            { target: 'AppImage', arch: ['armv7l'] },
            { target: 'deb', arch: ['armv7l'] },
          ],
          artifactName: 'DevBar-9.9.9-linux-armv7.${ext}',
        },
      });
    });

    it('keeps the empty linux platform list and never sets win', () => {
      const options = linuxConfig('arm64', 'full');
      expect(options.linux).toEqual([]);
      expect(options.win).toBeUndefined();
      expect(options.config).toMatchObject({
        linux: { artifactName: 'DevBar-9.9.9-linux-arm64.${ext}' },
      });
    });

    it('collapses dir mode to a single unpacked host-arch target', () => {
      const config = linuxConfig('armv7l', 'dir').config;
      const target = (config as { linux: { target: unknown[] } }).linux.target;
      expect(target).toHaveLength(1);
      expect(target[0]).toMatchObject({ target: 'dir' });
    });
  });

  describe('runBuild', () => {
    interface RecordingBuilder extends ElectronBuilderLike {
      calls: unknown[];
    }

    function recordingBuilder(failure?: Error): RecordingBuilder {
      const calls: unknown[] = [];
      return {
        calls,
        build: (options) => {
          calls.push(options);
          return failure ? Promise.reject(failure) : Promise.resolve([]);
        },
      };
    }

    it('invokes electron-builder once per Windows arch, in order', async () => {
      const builder = recordingBuilder();
      const lines = captureLog();
      await runBuild({ target: 'win', mode: 'full' }, builder, '9.9.9', ROOT);
      expect(builder.calls).toHaveLength(2);
      expect(builder.calls[0]).toMatchObject({
        win: [],
        config: {
          nsis: { artifactName: 'DevBar-9.9.9-win-x64-setup.${ext}' },
        },
      });
      expect(builder.calls[1]).toMatchObject({
        win: [],
        config: {
          nsis: { artifactName: 'DevBar-9.9.9-win-arm64-setup.${ext}' },
        },
      });
      expect(lines).toEqual(['[win] x64 done', '[win] arm64 done']);
    });

    it('invokes electron-builder once per Linux arch and reports armv7', async () => {
      const builder = recordingBuilder();
      const lines = captureLog();
      await runBuild({ target: 'linux', mode: 'full' }, builder, '9.9.9', ROOT);
      expect(builder.calls).toHaveLength(3);
      expect(builder.calls[2]).toMatchObject({
        linux: [],
        config: {
          linux: {
            target: [
              { target: 'AppImage', arch: ['armv7l'] },
              { target: 'deb', arch: ['armv7l'] },
            ],
            artifactName: 'DevBar-9.9.9-linux-armv7.${ext}',
          },
        },
      });
      // The progress line speaks the contract name, not the builder key.
      expect(lines).toEqual([
        '[linux] x64 done',
        '[linux] arm64 done',
        '[linux] armv7 done',
      ]);
    });

    it('builds a single unpacked target in dir mode', async () => {
      const builder = recordingBuilder();
      const lines = captureLog();
      await runBuild({ target: 'linux', mode: 'dir' }, builder, '9.9.9', ROOT);
      expect(builder.calls).toHaveLength(1);
      expect(builder.calls[0]).toMatchObject({
        config: { linux: { target: [{ target: 'dir' }] } },
      });
      expect(lines).toHaveLength(1);
    });

    it('stops at the arch that failed instead of building the rest', async () => {
      const builder = recordingBuilder(new Error('electron-builder exploded'));
      const lines = captureLog();
      await expect(
        runBuild({ target: 'win', mode: 'full' }, builder, '9.9.9', ROOT),
      ).rejects.toThrow('electron-builder exploded');
      expect(builder.calls).toHaveLength(1);
      expect(lines).toEqual([]);
    });
  });

  describe('main', () => {
    interface RuntimeRecorder {
      loaded: number;
      chdirs: string[];
      failures: string[];
      runtime: PackageRuntime;
      builder: { calls: unknown[] };
    }

    function recordingRuntime(): RuntimeRecorder {
      const builder = {
        calls: [] as unknown[],
        build: (options: unknown) => {
          builder.calls.push(options);
          return Promise.resolve([]);
        },
      };
      const recorder: RuntimeRecorder = {
        loaded: 0,
        chdirs: [],
        failures: [],
        builder,
        runtime: {
          loadBuilder: () => {
            recorder.loaded += 1;
            return Promise.resolve(builder);
          },
          chdir: (directory) => {
            recorder.chdirs.push(directory);
          },
          fail: (message) => {
            recorder.failures.push(message);
            throw new Error(`exit: ${message}`);
          },
        },
      };
      return recorder;
    }

    it('loads the builder and runs from the repo root', async () => {
      const recorder = recordingRuntime();
      captureLog();
      await main(['linux', 'host'], recorder.runtime);
      expect(recorder.loaded).toBe(1);
      // electron-builder writes dist/electron-builder relative to the CWD.
      expect(recorder.chdirs).toEqual([repositoryRoot]);
      expect(recorder.builder.calls).toHaveLength(1);
      expect(recorder.failures).toEqual([]);
    });

    it('never loads the builder when the arguments are wrong', async () => {
      const recorder = recordingRuntime();
      await expect(main(['hots'], recorder.runtime)).rejects.toThrow(
        `exit: ${PACKAGE_USAGE}`,
      );
      expect(recorder.failures).toEqual([PACKAGE_USAGE]);
      expect(recorder.loaded).toBe(0);
      expect(recorder.chdirs).toEqual([]);
      expect(recorder.builder.calls).toEqual([]);
    });
  });

  describe('module side effects', () => {
    it('imports without chdir-ing, loading electron-builder or building', () => {
      // The defect this file was restructured for: the work used to run at
      // MODULE SCOPE, so importing it pulled electron-builder in, chdir-ed
      // to the repo root and started a real multi-arch build.
      const directory = realpathSync(
        mkdtempSync(path.join(tmpdir(), 'devbar-pkg-import-')),
      );
      temporaryDirectories.push(directory);
      const moduleUrl = JSON.stringify(
        path.join(repositoryRoot, 'scripts', 'package-win-linux.ts'),
      );
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          `const m = await import(${moduleUrl});\n` +
            `process.stdout.write(JSON.stringify({ cwd: process.cwd(), exports: Object.keys(m).sort() }));`,
        ],
        { cwd: directory, encoding: 'utf8', timeout: 20_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const { cwd, exports } = JSON.parse(result.stdout) as {
        cwd: string;
        exports: string[];
      };
      // A top-level `process.chdir(ROOT)` would report the repo root here.
      expect(cwd).toBe(directory);
      expect(exports).toContain('baseConfig');
      expect(exports).toContain('parsePackageArgs');
    }, 30_000);
  });
});
