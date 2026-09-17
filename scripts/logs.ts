import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 */

function logPath(): string {
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Logs', 'DevBar', 'app.log');
  if (process.platform === 'win32')
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'DevBar',
      'logs',
      'app.log',
    );
  const config =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'DevBar', 'logs', 'app.log');
}

const LOG_PATH = process.env.DEVBAR_LOG_PATH || logPath();

if (!existsSync(LOG_PATH)) {
  console.log(
    `Aún no hay logs en ${LOG_PATH} (arranca DevBar primero, o define DEVBAR_LOG_PATH).`,
  );
  process.exit(0);
}

console.log(`Tailing ${LOG_PATH} (Ctrl+C para parar):`);

// Keep the child reference: without it a spawn that fails to start
// (binary missing, EACCES…) is an unhandled 'error', and a nonzero exit
// of tail/powershell would leave this wrapper reporting success.
const child =
  process.platform === 'win32'
    ? spawn(
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
          env: { ...process.env, DEVBAR_LOG_PATH: LOG_PATH },
        },
      )
    : spawn('tail', ['-F', LOG_PATH], { stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`No se pudo arrancar el tail de logs: ${err.message}`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  // A signal (Ctrl+C) exits with a null code — that is the expected way
  // out and must not look like a failure.
  if (code !== null && code !== 0) process.exitCode = code;
});
