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
 *
 * The routing table itself lives in `dispatch`, which receives every effect
 * it needs as an injected callback. That table is what turns `pnpm dist`
 * into the right builder with the right arguments on the right OS — the
 * part worth pinning — and it can only be pinned while nothing spawns.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/script-runtime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE =
  'usage: platform.ts <pack|dist|verify|dist:mac|install-local> [--dev]';

/** Everything `dispatch` needs from the outside world. */
export interface DispatchDeps {
  /** `process.platform` of the machine running the command. */
  platform: string;
  /** `--dev` was passed on the command line. */
  isDev: boolean;
  /** Everything after the command name (e.g. `--no-build`) — forwarded to
   *  the implementation that takes extra flags. */
  extraArgs: string[];
  /** Run `scripts/<script>` through bash. */
  runBash: (script: string) => void;
  /** Run `<script>` through this Node binary. */
  runNode: (script: string, args?: string[]) => void;
  /**
   * Abort with a message. In production this exits the process and never
   * returns; `dispatch` still stops explicitly at every call site, so a
   * `fail` that did return could never fall through into a build.
   */
  fail: (message: string) => void;
}

/** Route one command to the implementation for `deps.platform`. */
export function dispatch(
  command: string | undefined,
  deps: DispatchDeps,
): void {
  const { platform, isDev, extraArgs, runBash, runNode, fail } = deps;
  const unsupported = (): void => {
    fail(`unsupported platform: ${platform} — expected darwin, win32 or linux`);
  };

  if (command === undefined) {
    fail(USAGE);
    return;
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
      if (platform !== 'darwin') {
        fail(
          'dist:mac builds macOS release artifacts and requires macOS — on this OS use `pnpm dist`',
        );
        break;
      }
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
}

function fail(message: string): never {
  console.error(`[platform] ${message}`);
  process.exit(1);
}

/** Run a child to completion, adopting its failure as ours. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Direct execution: node --experimental-strip-types scripts/platform.ts …
if (isEntrypoint(import.meta.url)) {
  const isDev = process.argv.includes('--dev');
  dispatch(process.argv[2], {
    platform: process.platform,
    isDev,
    extraArgs: process.argv.slice(3),
    runBash: (script) => {
      run(
        'bash',
        [path.join(ROOT, 'scripts', script)],
        isDev ? { ...process.env, DEVBAR_DEV_PANEL: '1' } : process.env,
      );
    },
    runNode: (script, args = []) => {
      run(
        process.execPath,
        ['--experimental-strip-types', script, ...args],
        process.env,
      );
    },
    fail,
  });
}
