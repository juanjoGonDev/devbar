/**
 * Failures that used to leave no trace in app.log: main-process exceptions
 * and rejections nobody caught, and renderer/child processes that died.
 * Each becomes a `console.error` line — which the logger tees into app.log
 * AND the warn/error journal the bug report reads — followed by a
 * synchronous journal flush, because the process may be about to go down.
 *
 * Crash semantics are deliberately left as Electron has them:
 *
 *  - Uncaught exceptions are OBSERVED through `uncaughtExceptionMonitor`,
 *    never handled. Electron's own `uncaughtException` listener shows the
 *    "A JavaScript error occurred in the main process" dialog only while
 *    it is the sole listener; adding one would silently suppress that
 *    dialog. The monitor does not count as a listener, so the dialog and
 *    the keep-running default both stay exactly as they were.
 *  - Unhandled rejections: Electron's main process runs Node's legacy
 *    "warn" mode (measured: a warning on stderr, the process lives on). A
 *    listener replaces that warning with this error line — which still
 *    reaches stderr through the original console — and changes nothing
 *    else: the app kept running before and keeps running now.
 *  - A clean exit is not a failure: it is logged as info, off the report.
 */

import * as logger from '../logger.js';

type Listener = (...args: never[]) => void;

interface GoneDetails {
  reason?: string;
  exitCode?: number;
  type?: string;
  name?: string;
  serviceName?: string;
}

interface ProcessEvents {
  onProcess: (event: string, listener: Listener) => void;
  onApp: (event: string, listener: Listener) => void;
}

interface CrashReportingDeps extends ProcessEvents {
  log: {
    error: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  flush: () => void;
}

/** `config` for …/renderer/config.html#about — the window a user knows. */
function windowName(contents: unknown): string {
  try {
    const url = (contents as { getURL?: () => string } | null)?.getURL?.();
    const file = url ? new URL(url).pathname.split('/').pop() : '';
    return file ? file.replace(/\.html$/, '') : '?';
  } catch {
    return '?';
  }
}

function describeGone(details: GoneDetails): string {
  return [
    details.type ? `type=${details.type}` : '',
    details.name ? `name=${details.name}` : '',
    details.serviceName ? `service=${details.serviceName}` : '',
    `reason=${details.reason ?? '?'}`,
    `exitCode=${String(details.exitCode ?? '?')}`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function installCrashReporting(deps: CrashReportingDeps): void {
  const { log, flush } = deps;
  const report = (details: GoneDetails, what: string): void => {
    if (details.reason === 'clean-exit') log.info(`[crash] ${what}`);
    else {
      log.error(`[crash] ${what}`);
      flush();
    }
  };

  deps.onProcess(
    'uncaughtExceptionMonitor',
    (error: unknown, origin: string) => {
      log.error(`[crash] ${origin || 'uncaughtException'}:`, error);
      flush();
    },
  );
  deps.onProcess('unhandledRejection', (reason: unknown) => {
    log.error('[crash] unhandledRejection:', reason);
    flush();
  });
  deps.onProcess('exit', () => flush());

  deps.onApp(
    'render-process-gone',
    (_event: unknown, contents: unknown, details: GoneDetails) =>
      report(
        details,
        `render-process-gone window=${windowName(contents)} ${describeGone(details)}`,
      ),
  );
  deps.onApp('child-process-gone', (_event: unknown, details: GoneDetails) =>
    report(details, `child-process-gone ${describeGone(details)}`),
  );
}

/**
 * The composition root's one call: the file logger first — before anything
 * noisy, so early `console.*` lands in app.log — then the crash hooks that
 * write through it. A logger that fails to start never blocks startup.
 */
export function startMainDiagnostics(
  host: ProcessEvents & { logFilePath: () => string },
): void {
  try {
    logger.init({ filePath: host.logFilePath() });
    logger.attachMainConsole();
  } catch (e) {
    console.error('logger init failed:', e);
  }
  installCrashReporting({
    onProcess: host.onProcess,
    onApp: host.onApp,
    log: console,
    flush: logger.flushProblems,
  });
}
