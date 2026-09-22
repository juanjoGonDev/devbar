import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import type { BuildConfiguration, BuildOptions } from 'electron-builder';
import { isEntrypoint } from './lib/script-runtime.ts';

/**
 * electron-builder orchestration for the NON-macOS targets. macOS keeps its
 * own pipeline (scripts/package-electron.ts + the DMG/ZIP scripts) because it
 * carries the ad-hoc signing and notification-identity care that the current
 * releases depend on; Windows and Linux have no such per-bundle ritual, so a
 * standard builder is the right tool there.
 *
 * Targets (the release artifact names live in scripts/release-artifacts.ts):
 *   win:    NSIS installer + portable, x64 + arm64
 *   linux:  AppImage + .deb, x64 + arm64 + armv7 (arm64 = Raspberry Pi 4/5
 *           64-bit, armv7 = 32-bit Pi OS)
 *
 * electron-builder spells the 32-bit Pi arch "armv7l" while the artifact
 * contract calls it "armv7", so each arch is built in its own invocation
 * with an explicit artifact name. The app is pure JS, so cross-building
 * from any host works; downloads of the Electron runtime are cached.
 *
 * Usage: node --experimental-strip-types scripts/package-win-linux.ts win|linux [full|dir|host]
 *
 * With the `dir` argument only the unpacked app directory for the HOST
 * arch is produced (used by `pnpm run pack` / `pnpm install-local` for a
 * quick dev install — no installer, no portable, no AppImage/deb).
 *
 * Everything above the entrypoint guard is side-effect free on purpose:
 * importing this module (tests) must not pull electron-builder in, chdir
 * the process or start a build.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = packageJson.version;

export type PackageTarget = 'win' | 'linux';
/** dir = unpacked host dir only; host = full targets for the host arch only
 *  (CI update simulation builds one next-version artifact quickly);
 *  full = every arch the release contract ships. */
export type PackageMode = 'full' | 'dir' | 'host';

export const PACKAGE_USAGE =
  'Usage: package-win-linux.ts win|linux [full|dir|host]';

export interface PackageArgs {
  target: PackageTarget;
  mode: PackageMode;
}

/**
 * The CLI contract. A misspelled mode must NOT fall through: with plain
 * `dirOnly`/`hostOnly` booleans an unknown mode (e.g. `hots`) leaves both
 * false and silently starts the FULL multi-architecture build.
 */
export function parsePackageArgs(
  args: readonly (string | undefined)[],
): PackageArgs {
  const target = args[0];
  const mode = args[1] ?? 'full';
  if (target !== 'win' && target !== 'linux') throw new Error(PACKAGE_USAGE);
  if (mode !== 'full' && mode !== 'dir' && mode !== 'host')
    throw new Error(PACKAGE_USAGE);
  return { target, mode };
}

/** electron-builder arch key for the host CPU (dir/host mode builds one). */
export function hostArch(architecture: string = process.arch): string {
  switch (architecture) {
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'armv7l';
    default:
      return 'x64';
  }
}

/**
 * The unpacked output directory electron-builder writes for one arch.
 * x64 is the builder's default arch and gets NO suffix (`linux-unpacked`,
 * `win-unpacked`); every other arch is appended (`linux-arm64-unpacked` on
 * a Raspberry Pi 4/5, `win-arm64-unpacked` on Windows on ARM,
 * `linux-armv7l-unpacked` on 32-bit Pi OS). Anyone that reads a `dir`
 * target back must derive the name the same way — hardcoding the x64
 * spelling is how `pnpm install-local` failed on the Pi.
 */
export function unpackedDirName(
  target: PackageTarget,
  architecture: string = process.arch,
): string {
  const arch = hostArch(architecture);
  return `${target}${arch === 'x64' ? '' : `-${arch}`}-unpacked`;
}

/**
 * electron-builder's armv7 key is "armv7l"; the artifact contract says
 * "armv7". hostArch() already returns the builder key.
 */
export function contractArchName(builderArch: string): string {
  return builderArch === 'armv7l' ? 'armv7' : builderArch;
}

/** electron-builder arch keys to build, in order, for one mode. */
export function windowsArchs(mode: PackageMode): readonly string[] {
  return mode === 'full' ? ['x64', 'arm64'] : [hostArch()];
}

export function linuxArchs(mode: PackageMode): readonly string[] {
  return mode === 'full' ? ['x64', 'arm64', 'armv7l'] : [hostArch()];
}

/** electron-builder's `${ext}` template placeholder, per target type. */
function ext(): string {
  return '${ext}';
}

/**
 * What goes in the app bundle: the compiled app (build/), the icon assets
 * (the confirm modal inlines icon.png at runtime) and package.json (main
 * entry + metadata). Production node_modules are added by electron-builder
 * itself. Everything else in the repo is dev-only and stays out.
 *
 * Fresh base config per build() call. app-builder-lib normalizes (mutates)
 * the config it receives — reusing one object across the per-arch invocations
 * crashes the second call ("Cannot read properties of null (reading 'from')"
 * in normalizeFiles), so every invocation gets its own instance.
 */
export function baseConfig(): BuildConfiguration {
  return {
    appId: 'io.github.juanjogondev.devbar',
    productName: 'DevBar',
    asar: true,
    // No autoUpdater feed: DevBar does its own release checks + swaps.
    publish: null,
    directories: { output: 'dist/electron-builder' },
    // build/assets/fonts carries the bundled emoji webfont, which only the
    // LINUX packages include (linux.files below re-adds it — per-platform
    // file sets MERGE with this one, pinned by test); macOS has Apple Color
    // Emoji and Windows has Segoe UI Emoji, so the 5.5 MB stay out of their
    // artifacts.
    files: [
      'build/**/*',
      'assets/**/*',
      'package.json',
      '!build/assets/fonts/**',
    ],
  };
}

export interface BuildOptionsRequest {
  /** electron-builder arch key for this invocation. */
  arch: string;
  mode: PackageMode;
  version: string;
  root: string;
}

export function windowsBuildOptions({
  arch,
  mode,
  version,
  root,
}: BuildOptionsRequest): BuildOptions {
  return {
    // Force the platform: an empty list keeps the per-arch targets from
    // config.win.target, but without the flag electron-builder would build
    // for the HOST, so a `win` request from a Linux/macOS host would
    // silently produce a Linux bundle.
    win: [],
    config: {
      ...baseConfig(),
      win: {
        icon: path.join(root, 'assets', 'icon.ico'),
        target:
          mode === 'dir'
            ? [{ target: 'dir', arch: [hostArch()] }]
            : [
                { target: 'nsis', arch: [arch] },
                { target: 'portable', arch: [arch] },
              ],
      },
      nsis: {
        // One-click, per-user: no UAC prompt, installs to
        // %LOCALAPPDATA%\Programs\DevBar — exactly the location the in-app
        // updater recognises (src/self-update.ts → windowsUpdateMode).
        oneClick: true,
        perMachine: false,
        allowToChangeInstallationDirectory: false,
        deleteAppDataOnUninstall: false,
        artifactName: `DevBar-${version}-win-${arch}-setup.${ext()}`,
      },
      portable: {
        artifactName: `DevBar-${version}-win-${arch}-portable.${ext()}`,
      },
    },
  };
}

export function linuxBuildOptions({
  arch,
  mode,
  version,
  root,
}: BuildOptionsRequest): BuildOptions {
  return {
    // Force the platform — see windowsBuildOptions.
    linux: [],
    config: {
      ...baseConfig(),
      linux: {
        // The bundled emoji webfont: merged with the top-level file set
        // (verified against electron-builder 26: per-platform `files` are
        // ADDITIVE), so Linux artifacts ship build/assets/fonts while the
        // other platforms keep theirs lean. renderer/emoji.css consumes it.
        files: ['build/assets/fonts/**/*'],
        // Directory of pre-sized PNGs (16–256). A single PNG source is
        // embedded as-is, which would leave the .deb without the 256px
        // hicolor icon the desktop expects; a directory yields the full
        // hicolor set. Kept out of the app bundle (not under assets/).
        icon: path.join(root, 'buildResources', 'icons'),
        category: 'Development',
        maintainer: 'Juanjo González <juanjo96developer@gmail.com>',
        synopsis: 'Menu bar launcher for local development services',
        description:
          'Start and stop dev services, switch git branches per group, run actions and watch logs from the system tray.',
        target:
          mode === 'dir'
            ? [{ target: 'dir', arch: [hostArch()] }]
            : [
                { target: 'AppImage', arch: [arch] },
                { target: 'deb', arch: [arch] },
              ],
        artifactName: `DevBar-${version}-linux-${contractArchName(arch)}.${ext()}`,
      },
    },
  };
}

/**
 * Dynamic import with a friendly failure: after a `git pull` that adds
 * dependencies, node_modules can be out of sync (pnpm warns about it) and a
 * static import would die with a cryptic ERR_MODULE_NOT_FOUND. Kept inside
 * a function so importing this module never loads electron-builder.
 */
async function loadBuilder(): Promise<typeof import('electron-builder')> {
  try {
    return await import('electron-builder');
  } catch {
    console.error(
      'electron-builder no está disponible en node_modules.\n' +
        'Tu node_modules está desincronizado con el lockfile (p. ej. tras un git pull que añade dependencias).\n' +
        'Ejecuta: pnpm install\n' +
        '(y usa el pnpm fijado en package.json: corepack enable)',
    );
    process.exit(1);
  }
}

/** The only part of electron-builder's API this script drives. */
export interface ElectronBuilderLike {
  build(options: BuildOptions): Promise<unknown>;
}

/**
 * One electron-builder invocation per arch: app-builder-lib mutates the
 * config it is handed, and each arch needs its own artifact name.
 */
export async function runBuild(
  { target, mode }: PackageArgs,
  builder: ElectronBuilderLike,
  version: string = VERSION,
  root: string = ROOT,
): Promise<void> {
  if (target === 'win') {
    for (const arch of windowsArchs(mode)) {
      await builder.build(windowsBuildOptions({ arch, mode, version, root }));
      console.log(`[win] ${arch} done`);
    }
    return;
  }
  for (const arch of linuxArchs(mode)) {
    await builder.build(linuxBuildOptions({ arch, mode, version, root }));
    console.log(`[linux] ${contractArchName(arch)} done`);
  }
}

/** The process-level effects of a run, injected so tests can observe them. */
export interface PackageRuntime {
  loadBuilder: () => Promise<ElectronBuilderLike>;
  chdir: (directory: string) => void;
  fail: (message: string) => never;
}

const nodeRuntime: PackageRuntime = {
  loadBuilder,
  chdir: (directory) => process.chdir(directory),
  fail: (message) => {
    console.error(message);
    process.exit(1);
  },
};

export async function main(
  args: readonly (string | undefined)[],
  runtime: PackageRuntime = nodeRuntime,
): Promise<void> {
  let parsed: PackageArgs;
  try {
    parsed = parsePackageArgs(args);
  } catch (error) {
    // Nothing is loaded or built on a usage error: the arguments decide how
    // many architectures get built, so a typo must stop here.
    return runtime.fail(error instanceof Error ? error.message : String(error));
  }
  const builder = await runtime.loadBuilder();
  // electron-builder resolves `directories.output` and `files` against the
  // working directory, so the build must run from the repo root whatever
  // directory the caller invoked us from.
  runtime.chdir(ROOT);
  await runBuild(parsed, builder);
}

// Direct execution only: importing this module for its config builders
// (tests) must not start a build.
if (isEntrypoint(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
