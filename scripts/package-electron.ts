import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packager } from '@electron/packager';

const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64'] as const);
type Architecture = 'arm64' | 'x64';

/**
 * Paths kept out of the shipped app. The second pattern drops
 * `build/{src,renderer}/dev` — the development-only simulation panel and its
 * IPC handlers, which must never reach a packaged build.
 */
export const PACKAGE_IGNORE: readonly RegExp[] = [
  /^\/(?:dist|tests|\.agents|\.github|src|renderer|scripts|tsconfig(?:\.[^.]+)?\.json|eslint\.config\.ts|vitest\.config\.ts|knip\.json|\.dependency-cruiser\.json)(?:$|\/)/,
  /^\/build\/(?:src|renderer)\/dev(?:$|\/)/,
];

async function main(): Promise<void> {
  const [architectureValue, outputDirectory] = process.argv.slice(2);
  if (!SUPPORTED_ARCHITECTURES.has(architectureValue as Architecture)) {
    throw new Error(
      `Unsupported macOS architecture: ${architectureValue || '<missing>'}`,
    );
  }
  if (!outputDirectory) throw new Error('Output directory is required.');
  const architecture = architectureValue as Architecture;
  const rootDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  await packager({
    dir: rootDirectory,
    name: 'DevBar',
    platform: 'darwin',
    arch: architecture,
    /*
     * Our own reverse-DNS id. Left unset, packager defaults to
     * `com.electron.devbar` — Electron's namespace, not ours, which no shipped
     * app should be squatting in.
     *
     * It also unsticks notifications. macOS records the notification
     * authorisation per bundle id and never asks twice; `com.electron.devbar`
     * accumulated a decision back when the bundle was signed as "Electron" and
     * every notification was rejected. From then on the system accepted each
     * one and drew none, with no prompt and no error to notice. A fresh id gets
     * a fresh prompt.
     *
     * Safe to change: `app.getPath('userData')` keys off the app NAME, so
     * ~/Library/Application Support/DevBar and every setting in it stay put.
     */
    appBundleId: 'io.github.juanjogondev.devbar',
    out: path.resolve(outputDirectory),
    overwrite: true,
    ignore: [...PACKAGE_IGNORE],
    // The icon has to be set here rather than patched into Info.plist
    // afterwards: any edit to the plist invalidates the signature applied
    // below, and re-signing by hand is what broke the helpers before.
    icon: path.join(rootDirectory, 'assets', 'icon.icns'),
    // Ad-hoc signing (`-`), no certificate and no Apple account. Delegated to
    // @electron/osx-sign, which walks the bundle inside-out and gives each
    // nested helper and framework ITS OWN identifier. A blunt
    // `codesign --deep --identifier <app-id>` stamps the parent's identifier
    // onto every helper instead, leaving each one's signature disagreeing with
    // its own CFBundleIdentifier.
    // `identityValidation: false` is what actually makes `-` mean AD-HOC.
    // Without it osx-sign treats `-` as a search string, finds some unrelated
    // personal certificate in the keychain and fails with "this identity
    // cannot be used for signing code".
    //
    // Hardened Runtime must be OFF here. It defaults to on because it is a
    // prerequisite for notarization, but it also turns on library validation,
    // which requires every loaded library to share the signer's Team ID. An
    // ad-hoc signature has no Team ID, so the app dies at launch with
    // "Library not loaded: @rpath/Electron Framework.framework/Electron
    // Framework". Notarization is not on the table without a Developer ID
    // anyway, so nothing is lost by dropping it.
    osxSign: {
      identity: '-',
      identityValidation: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
  });
}

const entrypointPath = process.argv[1];
const isEntrypoint =
  entrypointPath !== undefined &&
  import.meta.url === pathToFileURL(entrypointPath).href;

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
