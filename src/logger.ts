import fs, { type WriteStream } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
let stream: WriteStream | null = null,
  bytesWritten = 0,
  maxBytes = DEFAULT_MAX_BYTES,
  capWarned = false;
function safeFormat(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return String(value);
  if (value instanceof Error)
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}
export function init(options: { filePath: string; maxBytes?: number }): void {
  const { filePath, maxBytes: cap } = options;
  if (!filePath) throw new Error('logger.init requires { filePath }');
  maxBytes =
    typeof cap === 'number' && Number.isFinite(cap) && cap > 0
      ? cap
      : DEFAULT_MAX_BYTES;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    bytesWritten = 0;
    capWarned = false;
    write('info', 'logger', [
      `Log session started → ${filePath} (cap ${maxBytes} bytes)`,
    ]);
  } catch (error: unknown) {
    stream = null;
    try {
      process.stderr.write(
        `[logger] init failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } catch {}
  }
}
function write(level: string, origin: string, args: unknown): void {
  if (!stream) return;
  if (bytesWritten >= maxBytes) {
    if (!capWarned) {
      capWarned = true;
      try {
        stream.write(
          `[${new Date().toISOString()}] [warn ] [logger] Cap reached (${maxBytes} bytes). Further entries dropped this session.\n`,
        );
      } catch {}
    }
    return;
  }
  try {
    const ts = new Date().toISOString(),
      lvl = (level || 'log').padEnd(5),
      values = Array.isArray(args) ? args : [args],
      line = `[${ts}] [${lvl}] [${origin || '?'}] ${values.map(safeFormat).join(' ')}\n`;
    stream.write(line);
    bytesWritten += Buffer.byteLength(line);
  } catch {}
}
export function attachMainConsole(): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        original(...args);
      } catch {}
      write(level, 'main', args);
    };
  }
}
export function attachWindowConsole(win: BrowserWindow, origin: string): void {
  if (!win.webContents) return;
  const map = ['verbose', 'info', 'warn ', 'error'];
  win.webContents.on('console-message', (_event, level, message) => {
    write(map[level] ?? 'log', origin || 'renderer', [message]);
  });
}
