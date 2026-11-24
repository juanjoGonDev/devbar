import { spawn } from 'node:child_process';
import { isBridgeLaunch } from './mcp/launch.js';

/**
 * The app's entry point (package.json `main`). Assistants run the MCP bridge
 * with DevBar's own binary and ELECTRON_RUN_AS_NODE=1 (connect-command.ts),
 * but a client that drops that variable (Codex on Windows does) starts the
 * whole app instead: a second instance, which made the running one open its
 * config window on every connection. Launched with the bridge script as its
 * first argument, DevBar runs the bridge whatever the environment says.
 *
 * Both imports are awaited: Electron emits `ready` only after the entry
 * point's top-level await settles, and main.ts must set itself up before it.
 */
const defaultApp = process.defaultApp === true;

if (isBridgeLaunch(process.argv, defaultApp)) {
  if (process.platform === 'win32' && !process.env.ELECTRON_RUN_AS_NODE) {
    // Electron's Windows main process exposes process.stdin as an EOF stream.
    // Run the bridge in Node mode so it receives the assistant's stdio.
    const cliIndex = defaultApp ? 2 : 1;
    const child = spawn(process.execPath, process.argv.slice(cliIndex), {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });

    child.once('error', (error) => {
      console.error('Could not start the MCP bridge:', error);
      process.exit(1);
    });
    child.once('exit', (code) => process.exit(code ?? 1));
  } else await import('./mcp/cli.js');
} else await import('./main.js');
