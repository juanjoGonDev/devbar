import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absoluteEnvDir, isEntrypoint } from './lib/script-runtime.ts';

/**
 * `pnpm run logs` — print the log file location and tail it live.
 *
 * Packaged builds write app.log under their per-OS "DevBar" data folder
 * (pinned explicitly in src/app-paths.ts, because on Linux Electron's
 * default keeps the package.json name). This script reproduces the same
 * convention outside Electron:
 *   macOS   ~/Library/Logs/DevBar/app.log
 *   Windows %APPDATA%\DevBar\logs\app.log
 *   Linux   $XDG_CONFIG_HOME/DevBar/logs/app.log (default ~/.config)
 *
 * `logPath` takes the platform and the home directory instead of reading
 * them, and `tailLogs` takes every effect it needs: all three OS layouts
 * and both child outcomes are then reachable from one machine.
 */

/** Where the log file lives for `platform`, given that user's home dir. */
export function logPath(platform: NodeJS.Platform, homedir: string): string {
  if (platform === 'darwin')
    return path.join(homedir, 'Library', 'Logs', 'DevBar', 'app.log');
  if (platform === 'win32')
    return path.join(
      absoluteEnvDir('APPDATA', path.join(homedir, 'AppData', 'Roaming')),
      'DevBar',
      'logs',
      'app.log',
    );
  const config = absoluteEnvDir(
    'XDG_CONFIG_HOME',
    path.join(homedir, '.config'),
  );
  return path.join(config, 'DevBar', 'logs', 'app.log');
}

/** The only part of a spawned child this script uses. */
export interface TailChild {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export interface TailSpawnOptions {
  stdio: 'inherit';
  env?: NodeJS.ProcessEnv;
}

export interface TailDeps {
  platform: NodeJS.Platform;
  /** The log file to tail. */
  logFile: string;
  /** Environment the child inherits (Windows passes the path through it). */
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  spawn: (
    command: string,
    args: string[],
    options: TailSpawnOptions,
  ) => TailChild;
  info: (message: string) => void;
  warn: (message: string) => void;
  setExitCode: (code: number) => void;
  /**
   * Wires a cleanup to run when this process is told to stop. `Ctrl+C` in a
   * terminal signals the whole process group and reaches the child anyway,
   * but a plain `kill` of this process does not — and `tail -F` then keeps
   * reading the file with nobody left to read it, one orphan per run.
   */
  onExit?: (cleanup: () => void) => void;
}

/**
 * Tail `deps.logFile`, or explain that there is nothing to tail yet.
 * Returns the child so the caller can tell the two apart; `null` means no
 * log file exists and nothing was spawned.
 */
export function tailLogs(deps: TailDeps): TailChild | null {
  const { platform, logFile, env, exists, info, warn, setExitCode } = deps;

  if (!exists(logFile)) {
    info(
      `Aún no hay logs en ${logFile} (arranca DevBar primero, o define DEVBAR_LOG_PATH).`,
    );
    return null;
  }

  info(`Tailing ${logFile} (Ctrl+C para parar):`);

  // Keep the child reference: without it a spawn that fails to start
  // (binary missing, EACCES…) is an unhandled 'error', and a nonzero exit
  // of tail/powershell would leave this wrapper reporting success.
  const child =
    platform === 'win32'
      ? deps.spawn(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-Content -LiteralPath $env:DEVBAR_LOG_PATH -Wait -Tail 100',
          ],
          // The path is passed via environment, not interpolated into the
          // command: a single quote in the path (e.g. a user profile named
          // o'Brien) would otherwise break the single-quoted PowerShell
          // string and spawn would fail to even parse the command.
          {
            stdio: 'inherit',
            env: { ...env, DEVBAR_LOG_PATH: logFile },
          },
        )
      : deps.spawn('tail', ['-F', logFile], { stdio: 'inherit' });

  deps.onExit?.(() => {
    try {
      child.kill();
    } catch {
      // Already gone: nothing to clean up.
    }
  });

  child.on('error', (error) => {
    warn(`No se pudo arrancar el tail de logs: ${error.message}`);
    setExitCode(1);
  });
  child.on('close', (code) => {
    // A signal (Ctrl+C) exits with a null code — that is the expected way
    // out and must not look like a failure.
    if (code !== null && code !== 0) setExitCode(code);
  });
  return child;
}

/** The bit of `process` the termination wiring needs. */
export interface TerminationHost {
  on: (event: string, listener: () => void) => unknown;
  exit: (code: number) => never | void;
}

/**
 * Runs `cleanup` when this process is asked to stop, whichever way it is
 * asked. `exit` alone is not enough: a signal ends the process without it,
 * and the signals alone are not enough either, because a normal end never
 * raises one.
 */
export function installTerminationCleanup(
  host: TerminationHost,
  cleanup: () => void,
): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    host.on(signal, () => {
      cleanup();
      host.exit(0);
    });
  }
  host.on('exit', cleanup);
}

// Direct execution: node --experimental-strip-types scripts/logs.ts
if (isEntrypoint(import.meta.url)) {
  tailLogs({
    platform: process.platform,
    logFile:
      process.env.DEVBAR_LOG_PATH || logPath(process.platform, os.homedir()),
    env: process.env,
    exists: existsSync,
    spawn: (command, args, options) => spawn(command, args, options),
    info: (message) => {
      console.log(message);
    },
    warn: (message) => {
      console.error(message);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    onExit: (cleanup) => installTerminationCleanup(process, cleanup),
  });
}
