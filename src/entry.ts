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
if (isBridgeLaunch(process.argv, process.defaultApp === true))
  await import('./mcp/cli.js');
else await import('./main.js');
