import { Worker } from 'node:worker_threads';

/**
 * An assistant's regular expression, tested off the main process. A pattern
 * like `(a+)+$` backtracks for minutes on one long line, and on the main
 * thread that freezes the tray, every window and every MCP session. Here it
 * runs in a worker that is killed when it overruns its budget.
 */

/** How long a search may take before it is cut off. */
const REGEX_BUDGET_MS = 1000;

const SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const pattern = new RegExp(workerData.source, workerData.flags);
parentPort.postMessage(workerData.lines.map((line) => pattern.test(line)));
`;

/** Which `lines` match, or null when the budget ran out (or it failed). */
export function testLines(
  source: string,
  flags: string,
  lines: readonly string[],
  budgetMs = REGEX_BUDGET_MS,
): Promise<boolean[] | null> {
  return new Promise((resolve) => {
    const worker = new Worker(SCRIPT, {
      eval: true,
      workerData: { source, flags, lines },
    });
    const finish = (hits: boolean[] | null): void => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(hits);
    };
    const timer = setTimeout(() => finish(null), budgetMs);
    worker.once('message', (hits: boolean[]) => finish(hits));
    worker.once('error', () => finish(null));
  });
}
