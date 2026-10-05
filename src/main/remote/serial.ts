/**
 * A line of asynchronous tasks run one at a time, in the order they were
 * handed over: each starts only once the one before it has settled. A task
 * that fails still fails for whoever awaited it, and the line goes on.
 *
 * «Control remoto» puts in it whatever can wait on the OS keychain — loading
 * or renewing the identity key, starting and stopping the server — so a
 * prompt the user has not answered yet never lets two of them interleave.
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
