/**
 * Whether this process was started to run the MCP stdio bridge: DevBar's
 * binary with the bridge script as its first argument, as the line Settings ›
 * MCP prints (`<binary> <…>/mcp/cli.js --home <folder>`). `defaultApp` is
 * Electron's `process.defaultApp`: `electron .` puts the app folder first.
 */
export function isBridgeLaunch(
  argv: readonly string[],
  defaultApp = false,
): boolean {
  const first = argv[defaultApp ? 2 : 1] ?? '';
  return /[\\/]mcp[\\/]cli\.js$/.test(first);
}
