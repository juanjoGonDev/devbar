import { describe, expect, it } from 'vitest';
import { connectCommands } from '../src/main/mcp/connect-command.js';

const MAC = {
  platform: 'darwin' as const,
  execPath: '/Applications/DevBar.app/Contents/MacOS/DevBar',
  cliPath:
    '/Applications/DevBar.app/Contents/Resources/app/build/src/mcp/cli.js',
  home: "/Users/ana o'neil/Library/Application Support/DevBar/mcp",
};

describe('src/main/mcp/connect-command.ts', () => {
  it('runs the bridge with the app binary in Node mode for Claude Code', () => {
    expect(connectCommands(MAC).claudeCode).toBe(
      "claude mcp add devbar --scope user -e ELECTRON_RUN_AS_NODE=1 -- '/Applications/DevBar.app/Contents/MacOS/DevBar' '/Applications/DevBar.app/Contents/Resources/app/build/src/mcp/cli.js' --home '/Users/ana o'\\''neil/Library/Application Support/DevBar/mcp'",
    );
  });

  it('gives Claude Desktop and Cursor the same mcpServers block', () => {
    const commands = connectCommands(MAC);

    const parsed: unknown = JSON.parse(commands.claudeDesktopJson);
    expect(parsed).toEqual({
      mcpServers: {
        devbar: {
          command: MAC.execPath,
          args: [MAC.cliPath, '--home', MAC.home],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    });
    expect(commands.cursorJson).toBe(commands.claudeDesktopJson);
  });

  it('prefixes the env assignment for a POSIX shell', () => {
    expect(connectCommands(MAC).generic).toMatch(
      /^ELECTRON_RUN_AS_NODE=1 '\/Applications/,
    );
  });

  it('uses double quotes and `set` on Windows', () => {
    const commands = connectCommands({
      platform: 'win32',
      execPath: 'C:\\Program Files\\DevBar\\DevBar.exe',
      cliPath: 'C:\\Program Files\\DevBar\\resources\\app.asar\\cli.js',
      home: 'C:\\Users\\ana\\AppData\\Roaming\\DevBar\\mcp',
    });

    expect(commands.generic).toBe(
      'set ELECTRON_RUN_AS_NODE=1 && "C:\\Program Files\\DevBar\\DevBar.exe" "C:\\Program Files\\DevBar\\resources\\app.asar\\cli.js" --home "C:\\Users\\ana\\AppData\\Roaming\\DevBar\\mcp"',
    );
  });
});
