/**
 * A line of asynchronous tasks run one at a time, in the order they were
 * handed over: each starts only once the one before it has settled. A task
 * that fails still fails for whoever awaited it, and the line goes on.
 *
 * «Control remoto» puts in it starting and stopping the server, port changes
 * and key renewals: listening and closing take their time, and two of them
 * must never interleave.
 */
export type Serial = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
