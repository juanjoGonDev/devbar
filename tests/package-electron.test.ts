import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  main,
  PACKAGE_IGNORE,
  PACKAGE_IGNORE_WITH_DEV,
  type PackagerRun,
} from '../scripts/package-electron.js';

type PackagerOptions = Parameters<PackagerRun>[0];

/**
 * A stand-in for @electron/packager. The real one downloads Electron,
 * builds a bundle and signs it, so the only thing a test can assert about
 * this script is the option set it hands over — which is exactly what
 * decides what ships.
 */
function recordingPackager(): { calls: PackagerOptions[]; run: PackagerRun } {
  const calls: PackagerOptions[] = [];
  const run: PackagerRun = (options) => {
    calls.push(options);
    return Promise.resolve([]);
  };
  return { calls, run };
}

async function packageOptions(argv: string[]): Promise<PackagerOptions> {
  const { calls, run } = recordingPackager();
  await main(argv, run);
  expect(calls).toHaveLength(1);
  return calls[0];
}

const temporaryDirectories: string[] = [];

describe('scripts/package-electron.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  describe('argument validation', () => {
    const unsupported: [string[], string][] = [
      [[], 'Unsupported macOS architecture: <missing>'],
      [['', 'out'], 'Unsupported macOS architecture: <missing>'],
      [['ia32', 'out'], 'Unsupported macOS architecture: ia32'],
      [['universal', 'out'], 'Unsupported macOS architecture: universal'],
      [['darwin', 'out'], 'Unsupported macOS architecture: darwin'],
    ];

    it.each(unsupported)(
      'refuses %j and packages nothing',
      async (argv, message) => {
        const { calls, run } = recordingPackager();

        await expect(main(argv, run)).rejects.toThrow(message);
        expect(calls).toEqual([]);
      },
    );

    it('requires an output directory and packages nothing without one', async () => {
      const { calls, run } = recordingPackager();

      await expect(main(['arm64'], run)).rejects.toThrow(
        'Output directory is required.',
      );
      await expect(main(['x64', ''], run)).rejects.toThrow(
        'Output directory is required.',
      );
      expect(calls).toEqual([]);
    });
  });

  describe('packager options', () => {
    it.each(['arm64', 'x64'])(
      'packages a darwin %s bundle named DevBar',
      async (architecture) => {
        const options = await packageOptions([architecture, 'out']);

        expect(options.platform).toBe('darwin');
        expect(options.arch).toBe(architecture);
        expect(options.name).toBe('DevBar');
        expect(options.overwrite).toBe(true);
      },
    );

    it('claims our own reverse-DNS bundle id', async () => {
      // Left unset, packager defaults to com.electron.devbar — Electron's
      // namespace, where a shipped app must not squat.
      const options = await packageOptions(['arm64', 'out']);

      expect(options.appBundleId).toBe('io.github.juanjogondev.devbar');
    });

    it('resolves a relative output directory against the working directory', async () => {
      const options = await packageOptions([
        'arm64',
        path.join('dist', 'relative-out'),
      ]);

      expect(options.out).toBe(
        path.join(process.cwd(), 'dist', 'relative-out'),
      );
    });

    it('leaves an absolute output directory alone', async () => {
      const absolute = path.join(path.sep, 'tmp', 'devbar-out');
      const options = await packageOptions(['x64', absolute]);

      expect(options.out).toBe(absolute);
    });

    it('packages an absolute root and takes the icon from inside it', async () => {
      const options = await packageOptions(['arm64', 'out']);

      expect(path.isAbsolute(options.dir)).toBe(true);
      expect(options.icon).toBe(path.join(options.dir, 'assets', 'icon.icns'));
    });

    it('excludes the dev simulation panel unless it is asked for', async () => {
      vi.stubEnv('DEVBAR_DEV_PANEL', '0');

      expect((await packageOptions(['x64', 'out'])).ignore).toEqual([
        ...PACKAGE_IGNORE,
      ]);
    });

    it('keeps the dev simulation panel when DEVBAR_DEV_PANEL is exactly 1', async () => {
      vi.stubEnv('DEVBAR_DEV_PANEL', '1');

      const ignore = (await packageOptions(['x64', 'out'])).ignore;
      expect(ignore).toEqual([...PACKAGE_IGNORE_WITH_DEV]);
      expect(ignore).not.toEqual([...PACKAGE_IGNORE]);
    });

    it('treats any other DEVBAR_DEV_PANEL value as off', async () => {
      vi.stubEnv('DEVBAR_DEV_PANEL', 'true');

      expect((await packageOptions(['x64', 'out'])).ignore).toEqual([
        ...PACKAGE_IGNORE,
      ]);
    });

    it('signs ad-hoc, with identity validation and hardened runtime off', async () => {
      // `identityValidation: false` is what makes `-` mean ad-hoc, and the
      // hardened runtime would enable library validation, which an ad-hoc
      // signature (no Team ID) cannot satisfy — the app dies at launch.
      const options = await packageOptions(['arm64', 'out']);

      expect(options.osxSign).toMatchObject({
        identity: '-',
        identityValidation: false,
      });
      expect(
        typeof options.osxSign === 'object'
          ? options.osxSign.optionsForFile?.('/Applications/DevBar.app', {
              platform: 'darwin',
            })
          : undefined,
      ).toEqual({ hardenedRuntime: false });
    });
  });

  describe('command-line entrypoint', () => {
    it('runs main() when the checkout is reached through a symlink', () => {
      // `import.meta.url` is realpath-resolved by Node while
      // `process.argv[1]` is not, so comparing them raw made the guard
      // FALSE here: package-macos-app.sh got a silent exit 0 and no bundle.
      const directory = mkdtempSync(
        path.join(tmpdir(), 'devbar-packager-symlink-'),
      );
      temporaryDirectories.push(directory);
      const checkout = path.join(directory, 'checkout');
      symlinkSync(process.cwd(), checkout, 'dir');

      // No architecture argument, so reaching main() is observable as a
      // refusal — without ever invoking the real packager.
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.join(checkout, 'scripts', 'package-electron.ts'),
        ],
        { encoding: 'utf8' },
      );

      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain(
        'Unsupported macOS architecture: <missing>',
      );
    });
  });
});
