/**
 * Socket-based port detection: which TCP ports each running service's
 * PROCESS TREE is listening on. One scan answers every root pid at once — one
 * process-table read and one socket listing per scan, however many services
 * run — so the cost does not grow with the number of commands.
 *
 * The tools are reached only through the injected `run`, which the tests fake:
 * no real process is ever spawned under test.
 */
import { execFile } from 'node:child_process';
import {
  descendantsOf,
  parseLsof,
  parseNetstat,
  parsePidTable,
  parseSs,
  type ListenSocket,
} from './socket-parsers.js';

/** stdout of `file args`, or null when the tool is not installed at all. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<string | null>;

export interface SocketScanDeps {
  platform: NodeJS.Platform;
  run: CommandRunner;
}

const SCAN_TIMEOUT_MS = 4000;

/**
 * The production runner: async, bounded by a timeout, and tolerant of a
 * non-zero exit (lsof exits 1 when nothing matches, which is an empty answer,
 * not a failure). Only a missing binary answers null.
 */
const execRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 << 20 },
      (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve(code === 'ENOENT' ? null : String(stdout ?? ''));
      },
    );
  });

const WINDOWS_PID_TABLE = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
];

async function pidTable(deps: SocketScanDeps): Promise<Map<number, number>> {
  const stdout =
    deps.platform === 'win32'
      ? await deps.run('powershell.exe', WINDOWS_PID_TABLE)
      : await deps.run('ps', ['-A', '-o', 'pid=,ppid=']);
  return parsePidTable(stdout ?? '');
}

async function listSockets(
  pids: readonly number[],
  deps: SocketScanDeps,
): Promise<ListenSocket[]> {
  if (deps.platform === 'win32')
    return parseNetstat(
      (await deps.run('netstat', ['-ano', '-p', 'tcp'])) ?? '',
    );
  const lsof = await deps.run('lsof', [
    '-nP',
    '-iTCP',
    '-sTCP:LISTEN',
    '-a',
    '-p',
    pids.join(','),
    '-F',
    'pn',
  ]);
  if (lsof !== null) return parseLsof(lsof);
  if (deps.platform !== 'linux') return [];
  return parseSs((await deps.run('ss', ['-ltnp'])) ?? '');
}

/**
 * Every listening socket below each root pid, keyed by that root. A root
 * whose tree listens on nothing maps to an empty list; a tool that fails
 * leaves every root empty rather than throwing.
 */
export async function scanListeningSockets(
  roots: readonly number[],
  deps: SocketScanDeps = { platform: process.platform, run: execRunner },
): Promise<Map<number, ListenSocket[]>> {
  const result = new Map<number, ListenSocket[]>(
    roots.map((root) => [root, []]),
  );
  if (roots.length === 0) return result;
  const table = await pidTable(deps);
  const owner = new Map<number, number>();
  for (const root of roots)
    for (const pid of descendantsOf(root, table))
      if (!owner.has(pid)) owner.set(pid, root);
  const sockets = await listSockets([...owner.keys()], deps);
  for (const socket of sockets) {
    const root = owner.get(socket.pid);
    if (root !== undefined) result.get(root)?.push(socket);
  }
  return result;
}
