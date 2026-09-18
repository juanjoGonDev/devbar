/**
 * Sends a window's uncaught failures to the console, which the main process
 * forwards to `app.log` (see `attachWindowConsole` in src/logger.ts).
 *
 * Without this a renderer crash leaves no trace anywhere: the window keeps
 * its last painted state, `app.log` says nothing, and a packaged build has no
 * devtools to open — so "it broke and I don't know why" is where the
 * investigation ends. Each entry point imports this for its side effect,
 * before anything that can throw.
 *
 * Toasts are not a substitute: they are gone in seconds and never written
 * down. A path that shows the user an error should ALSO log it.
 */

function describe(value: unknown): string {
  if (value instanceof Error)
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Idempotent: a window that imports this twice (directly and through a
 * module it pulls in) must not report every failure twice.
 */
let installed = false;

export function installUncaughtReporting(
  target: Pick<Window, 'addEventListener'> = window,
): void {
  if (installed) return;
  installed = true;

  target.addEventListener('error', (event: Event) => {
    const detail = event as ErrorEvent;
    // `error` is absent for resource failures (a missing stylesheet or
    // script), where `message` is empty too — name the source instead, or
    // the log line would say nothing at all.
    const what =
      detail.error !== undefined && detail.error !== null
        ? describe(detail.error)
        : detail.message ||
          `failed to load ${String((detail.target as { src?: string } | null)?.src ?? 'a resource')}`;
    const where =
      detail.filename !== undefined && detail.filename !== ''
        ? ` (${detail.filename}:${String(detail.lineno ?? 0)}:${String(detail.colno ?? 0)})`
        : '';
    console.error(`Uncaught${where}: ${what}`);
  });

  target.addEventListener('unhandledrejection', (event: Event) => {
    const detail = event as PromiseRejectionEvent;
    console.error(`Unhandled rejection: ${describe(detail.reason)}`);
  });
}

/** Test seam: lets a suite reinstall onto a fresh fake window. */
export function resetUncaughtReportingForTests(): void {
  installed = false;
}

installUncaughtReporting();
