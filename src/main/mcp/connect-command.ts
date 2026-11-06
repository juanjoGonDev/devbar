import type { McpConnectCommands } from '../../ipc-contract/mcp-api.js';

/**
 * The ready-to-paste lines Settings › MCP offers for connecting an assistant.
 * They run the stdio bridge (`build/src/mcp/cli.js`) with the app's own
 * binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so nothing has to be
 * installed besides DevBar — in development the binary is the Electron of
 * node_modules, packaged it is DevBar itself.
 */

export interface ConnectPaths {
  platform: NodeJS.Platform;
  /** The binary that runs the bridge (`process.execPath`). */
  execPath: string;
  /** The bridge script. */
  cliPath: string;
  /** The app's MCP folder, handed to the bridge as `--home`. */
  home: string;
}

const SERVER_NAME = 'devbar';
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

/** POSIX shells: single quotes, with any single quote spliced in. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** cmd.exe / PowerShell: double quotes (paths cannot contain one). */
function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '')}"`;
}

/** A TOML basic string: its escapes are JSON's for every path character. */
const tomlString = (value: string): string => JSON.stringify(value);

export function connectCommands(paths: ConnectPaths): McpConnectCommands {
  const quote = paths.platform === 'win32' ? windowsQuote : posixQuote;
  const args = [paths.cliPath, '--home', paths.home];
  const commandLine = [
    quote(paths.execPath),
    quote(paths.cliPath),
    '--home',
    quote(paths.home),
  ].join(' ');
  const json = JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: paths.execPath,
          args,
          env: { [RUN_AS_NODE]: '1' },
        },
      },
    },
    null,
    2,
  );
  return {
    claudeCode: `claude mcp add ${SERVER_NAME} --scope user -e ${RUN_AS_NODE}=1 -- ${commandLine}`,
    claudeDesktopJson: json,
    cursorJson: json,
    opencodeJson: JSON.stringify(
      {
        mcp: {
          [SERVER_NAME]: {
            type: 'local',
            command: [paths.execPath, ...args],
            environment: { [RUN_AS_NODE]: '1' },
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
    codexToml: [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(paths.execPath)}`,
      `args = [${args.map(tomlString).join(', ')}]`,
      `env = { ${RUN_AS_NODE} = "1" }`,
    ].join('\n'),
    generic:
      paths.platform === 'win32'
        ? `set ${RUN_AS_NODE}=1 && ${commandLine}`
        : `${RUN_AS_NODE}=1 ${commandLine}`,
  };
}
