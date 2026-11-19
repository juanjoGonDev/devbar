import { describe, expect, it } from 'vitest';
import { isBridgeLaunch } from '../src/mcp/launch.js';

describe('src/mcp/launch.ts', () => {
  const winExe = 'C:\\Users\\me\\AppData\\Local\\Programs\\DevBar\\DevBar.exe';
  const winCli =
    'C:\\Users\\me\\AppData\\Local\\Programs\\DevBar\\resources\\app.asar\\build\\src\\mcp\\cli.js';

  it('spots the bridge line an assistant runs on Windows', () => {
    // What Codex ran, without ELECTRON_RUN_AS_NODE reaching DevBar.
    expect(
      isBridgeLaunch([winExe, winCli, '--home', 'C:\\Users\\me\\mcp']),
    ).toBe(true);
  });

  it('spots the bridge line on macOS and Linux', () => {
    expect(
      isBridgeLaunch([
        '/Applications/DevBar.app/Contents/MacOS/DevBar',
        '/Applications/DevBar.app/Contents/Resources/app.asar/build/src/mcp/cli.js',
        '--home',
        '/Users/me/mcp',
      ]),
    ).toBe(true);
  });

  it('skips the app folder `electron .` puts first', () => {
    const argv = ['/repo/electron', '.', '/repo/build/src/mcp/cli.js'];
    expect(isBridgeLaunch(argv, true)).toBe(true);
    expect(isBridgeLaunch(argv)).toBe(false);
  });

  it('leaves every other launch to the app', () => {
    expect(isBridgeLaunch([winExe])).toBe(false);
    expect(isBridgeLaunch([winExe, '--hidden'])).toBe(false);
    expect(isBridgeLaunch([winExe, 'C:\\tools\\cli.js'])).toBe(false);
    // The script named anywhere but first is an argument, not the bridge.
    expect(isBridgeLaunch([winExe, '--hidden', winCli])).toBe(false);
  });
});
