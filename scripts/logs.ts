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

if (process.platform === 'win32') {
  spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-Content -LiteralPath '${LOG_PATH}' -Wait -Tail 100`,
    ],
    { stdio: 'inherit' },
  );
} else {
  spawn('tail', ['-F', LOG_PATH], { stdio: 'inherit' });
}
