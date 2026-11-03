import fs from 'node:fs';
import net from 'node:net';
import { runBridge } from './bridge.js';

/**
 * Entry point of the stdio bridge, run by an assistant as
 * `ELECTRON_RUN_AS_NODE=1 <DevBar binary> <this file> --home <mcp folder>`
 * (Settings › MCP prints the exact line). Everything it does is in
 * bridge.ts; this only hands it the real process and the real network.
 */
void runBridge({
  argv: process.argv.slice(2),
  platform: process.platform,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  connect: (path) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(path);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(socket);
      });
      socket.once('error', reject);
    }),
  exit: (code) => process.exit(code),
});
