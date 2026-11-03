/**
 * Pure parsers for the OS tools that list listening TCP sockets, plus the
 * process-tree walk that maps a service's root pid to every pid below it.
 * Each takes the tool's raw stdout and never throws: a line it does not
 * understand is skipped, so a tool version printing an extra column costs a
 * missed port, never a crash.
 */

export interface ListenSocket {
  pid: number;
  /** As the tool prints it: `*`, `0.0.0.0`, `[::]`, `127.0.0.1`, a LAN IP… */
  host: string;
  port: number;
}

function toInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** `host:port` → its two halves; the last colon splits, so `[::1]:80` works. */
function splitAddress(address: string): { host: string; port: number } | null {
  const at = address.lastIndexOf(':');
  if (at <= 0) return null;
  const port = toInt(address.slice(at + 1));
  if (port === null || port < 1 || port > 65535) return null;
  // ss suffixes the interface (`127.0.0.53%lo`); it is not part of the host.
  const host = address.slice(0, at).replace(/%[^\]]*$/, '');
  return { host, port };
}

/** `lsof … -F pn`: a `p<pid>` line opens a process, `n<host:port>` per socket. */
export function parseLsof(stdout: string): ListenSocket[] {
  const sockets: ListenSocket[] = [];
  let pid: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = toInt(line.slice(1));
    else if (line.startsWith('n') && pid !== null) {
      const address = splitAddress(line.slice(1).replace(/ .*$/, ''));
      if (address) sockets.push({ pid, ...address });
    }
  }
  return sockets;
}

/** `ss -ltnp`: the 4th column is the local address, `pid=` the owners. */
export function parseSs(stdout: string): ListenSocket[] {
  const sockets: ListenSocket[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'LISTEN') continue;
    const address = splitAddress(columns[3] ?? '');
    if (!address) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = toInt(match[1]);
      if (pid !== null) sockets.push({ pid, ...address });
    }
  }
  return sockets;
}

/**
 * `netstat -ano -p tcp`. The state column is translated on non-English
 * Windows («ESCUCHANDO», «ABHÖREN»), so a listening row is recognised by its
 * remote address instead: a listener has none, which netstat prints as port 0.
 */
export function parseNetstat(stdout: string): ListenSocket[] {
  const sockets: ListenSocket[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP' || !/:0$/.test(columns[2] ?? '')) continue;
    const address = splitAddress(columns[1] ?? '');
    const pid = toInt(columns[columns.length - 1]);
    if (address && pid !== null) sockets.push({ pid, ...address });
  }
  return sockets;
}

/** A `pid ppid` table (`ps -A -o pid=,ppid=`, or the Windows equivalent). */
export function parsePidTable(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const [rawPid, rawParent] = line.trim().split(/\s+/);
    const pid = toInt(rawPid);
    const parent = toInt(rawParent);
    if (pid !== null && parent !== null) table.set(pid, parent);
  }
  return table;
}

/** `root` and every process whose ancestry reaches it. */
export function descendantsOf(
  root: number,
  table: ReadonlyMap<number, number>,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of table) {
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const found = new Set<number>([root]);
  const queue = [root];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}
