import { build } from 'electron-builder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

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
 * Usage: node --experimental-strip-types scripts/package-win-linux.ts win|linux
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = packageJson.version;

/**
 * What goes in the app bundle: the compiled app (build/), the icon assets
 * (the confirm modal inlines icon.png at runtime) and package.json (main
 * entry + metadata). Production node_modules are added by electron-builder
 * itself. Everything else in the repo is dev-only and stays out.
 */
/**
 * Fresh base config per build() call. app-builder-lib normalizes (mutates)
 * the config it receives — reusing one object across the per-arch invocations
 * crashes the second call ("Cannot read properties of null (reading 'from')"
 * in normalizeFiles), so every invocation gets its own instance.
 */
function baseConfig(): Record<string, unknown> {
  return {
    appId: 'io.github.juanjogondev.devbar',
    productName: 'DevBar',
    asar: true,
    // No autoUpdater feed: DevBar does its own release checks + swaps.
    publish: null,
    directories: { output: 'dist/electron-builder' },
    files: ['build/**/*', 'assets/**/*', 'package.json'],
  };
}

async function buildWindows(): Promise<void> {
  for (const arch of ['x64', 'arm64'] as const) {
    await build({
      config: {
        ...baseConfig(),
        win: {
          icon: path.join(ROOT, 'assets', 'icon.ico'),
          target: [
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
          artifactName: `DevBar-${VERSION}-win-${arch}-setup.${ext()}`,
        },
        portable: {
          artifactName: `DevBar-${VERSION}-win-${arch}-portable.${ext()}`,
        },
      },
    });
    console.log(`[win] ${arch} done`);
  }
}

async function buildLinux(): Promise<void> {
  // [electron-builder arch key, artifact-contract arch name]
  for (const [builderArch, contractArch] of [
    ['x64', 'x64'],
    ['arm64', 'arm64'],
    ['armv7l', 'armv7'],
  ] as const) {
    await build({
      config: {
        ...baseConfig(),
        linux: {
          // Directory of pre-sized PNGs (16–256). A single PNG source is
          // embedded as-is, which would leave the .deb without the 256px
          // hicolor icon the desktop expects; a directory yields the full
          // hicolor set. Kept out of the app bundle (not under assets/).
          icon: path.join(ROOT, 'buildResources', 'icons'),
          category: 'Development',
          maintainer: 'Juanjo González <juanjo96developer@gmail.com>',
          synopsis: 'Menu bar launcher for local development services',
          description:
            'Start and stop dev services, switch git branches per group, run actions and watch logs from the system tray.',
          target: [
            { target: 'AppImage', arch: [builderArch] },
            { target: 'deb', arch: [builderArch] },
          ],
          artifactName: `DevBar-${VERSION}-linux-${contractArch}.${ext()}`,
        },
      },
    });
    console.log(`[linux] ${contractArch} done`);
  }
}

/** electron-builder's `${ext}` template placeholder, per target type. */
function ext(): string {
  return '${ext}';
}

const target = process.argv[2];
if (target !== 'win' && target !== 'linux') {
  console.error('Usage: package-win-linux.ts win|linux');
  process.exit(1);
}

process.chdir(ROOT);
void (target === 'win' ? buildWindows() : buildLinux()).catch((error) => {
  console.error(error);
  process.exit(1);
});
