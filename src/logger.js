'use strict';

/**
 * Tiny file logger for DevBar.
 *
 * - Single file (`app.log`) under `app.getPath('logs')` → on macOS that's
 *   `~/Library/Logs/DevBar/app.log`. The packaged app is sandbox-free but
 *   we still want to write somewhere the system has blessed for app logs;
 *   that path is also where install-local.sh drops a symlink at the repo
 *   root so the user can `tail -f app.log` from the project.
 * - Truncated on every app start (fresh log per session).
 * - Hard cap per session (default 5 MB): once reached, further entries are
 *   silently dropped (one cap-reached warning is appended).
 * - Captures `console.*` from the main process AND every renderer
 *   (tray, config, logs) via `webContents.on('console-message')`.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

let stream = null;
let bytesWritten = 0;
let maxBytes = DEFAULT_MAX_BYTES;
let capWarned = false;
let logFilePath = null;

function safeFormat(arg) {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}` + (arg.stack ? `\n${arg.stack}` : '');
  }
  try {
    return JSON.stringify(arg);
  } catch {
    try {
      return String(arg);
    } catch {
      return '[unserializable]';
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.filePath  - absolute path to the log file
 * @param {number} [opts.maxBytes] - cap per session
 */
function init({ filePath, maxBytes: cap } = {}) {
  if (!filePath) throw new Error('logger.init requires { filePath }');
  logFilePath = filePath;
  maxBytes = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_BYTES;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, ''); // truncate
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    bytesWritten = 0;
    capWarned = false;
    write('info', 'logger', [
      `Log session started → ${filePath} (cap ${maxBytes} bytes)`,
    ]);
  } catch (e) {
    stream = null;
    // best-effort: logger is optional
    try {
      process.stderr.write(`[logger] init failed: ${e.message}\n`);
    } catch {}
  }
}

function getPath() {
  return logFilePath;
}

function write(level, origin, args) {
  if (!stream) return;
  if (bytesWritten >= maxBytes) {
    if (!capWarned) {
      capWarned = true;
      const note = `[${new Date().toISOString()}] [warn ] [logger] Cap reached (${maxBytes} bytes). Further entries dropped this session.\n`;
      try {
        stream.write(note);
      } catch {}
    }
    return;
  }
  try {
    const ts = new Date().toISOString();
    const lvl = String(level || 'log').padEnd(5);
    const msg = (Array.isArray(args) ? args : [args]).map(safeFormat).join(' ');
    const line = `[${ts}] [${lvl}] [${origin || '?'}] ${msg}\n`;
    stream.write(line);
    bytesWritten += Buffer.byteLength(line);
  } catch {
    // swallow — logger must never throw upwards
  }
}

/**
 * Wrap `console.log/info/warn/error` so calls from the main process are
 * mirrored to the log file in addition to stdout/stderr.
 */
function attachMainConsole() {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        orig(...args);
      } catch {}
      write(level, 'main', args);
    };
  }
}

/**
 * Capture every console.* message from a renderer window.
 * Electron emits `console-message` with an integer level:
 *   0=verbose, 1=info, 2=warning, 3=error.
 *
 * @param {Electron.BrowserWindow} win
 * @param {string} origin  human label (e.g. 'tray', 'config', 'logs:<id>')
 */
function attachWindowConsole(win, origin) {
  if (!win || !win.webContents) return;
  const map = ['verbose', 'info', 'warn ', 'error'];
  win.webContents.on(
    'console-message',
    (_event, levelInt, message /*, line, sourceId*/) => {
      write(map[levelInt] || 'log', origin || 'renderer', [message]);
    },
  );
}

module.exports = {
  init,
  getPath,
  write,
  attachMainConsole,
  attachWindowConsole,
};
