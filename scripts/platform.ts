/**
 * OS router behind the original pnpm commands (`pack`, `dist`, `verify`,
 * `install-local`, `dist:mac`). The commands themselves stay
 * OS-agnostic: this script inspects process.platform and dispatches to the
 * matching implementation —
 *
 *   darwin → the original bash pipeline (unchanged)
 *   win32  → electron-builder via scripts/package-win-linux.ts
 *   linux  → electron-builder via scripts/package-win-linux.ts
 *
 * Usage: node --experimental-strip-types scripts/platform.ts
 *         <pack|dist|verify|dist:mac|install-local> [--dev]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const isDev = process.argv.includes('--dev');
const platform = process.platform;
/** Everything after the command name (e.g. `--no-build`) — forwarded to the
 *  implementation that takes extra flags. */
const extraArgs = process.argv.slice(3);

function fail(message: string): never {
  console.error(`[platform] ${message}`);
  process.exit(1);
}

function runBash(script: string): void {
  const result = spawnSync('bash', [path.join(ROOT, 'scripts', script)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: isDev ? { ...process.env, DEVBAR_DEV_PANEL: '1' } : process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNode(script: string, args: string[] = []): void {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, ...args],
    { stdio: 'inherit', cwd: ROOT },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const unsupported = (): never =>
  fail(`unsupported platform: ${platform} — expected darwin, win32 or linux`);

if (command === undefined) {
  fail('usage: platform.ts <pack|dist|verify|dist:mac|install-local> [--dev]');
}

switch (command) {
  case 'pack':
    if (platform === 'darwin') runBash('package-macos-app.sh');
    else if (platform === 'win32' || platform === 'linux')
      runNode('scripts/package-win-linux.ts', [
        platform === 'win32' ? 'win' : 'linux',
        'dir',
      ]);
    else unsupported();
    break;

  case 'dist':
    if (platform === 'darwin') runBash('build-macos-release.sh');
    else if (platform === 'win32' || platform === 'linux')
      runNode('scripts/package-win-linux.ts', [
        platform === 'win32' ? 'win' : 'linux',
      ]);
    else unsupported();
    break;

  case 'dist:mac':
    if (platform !== 'darwin')
      fail(
        'dist:mac builds macOS release artifacts and requires macOS — on this OS use `pnpm dist`',
      );
    runBash('build-macos-release.sh');
    break;

  case 'verify':
    if (platform === 'darwin') runBash('verify-macos-release.sh');
    else if (platform === 'win32')
      runNode('build/scripts/verify-win-release.js');
    else if (platform === 'linux')
      runNode('build/scripts/verify-linux-release.js');
    else unsupported();
    break;

  case 'install-local':
    if (platform === 'darwin') runBash('install-local.sh');
    else if (platform === 'win32' || platform === 'linux') {
      runNode('scripts/install-local.ts', [
        ...(isDev ? ['--dev'] : []),
        ...extraArgs,
      ]);
      // An unpacked copy is invisible to the OS UI; register it in the app
      // menu (Linux) / Start Menu (Windows). Best effort — it only warns.
      runNode('scripts/register-launcher.ts');
    } else unsupported();
    break;

  default:
    fail(
      `unknown command: ${command} — expected pack|dist|verify|dist:mac|install-local`,
    );
}
