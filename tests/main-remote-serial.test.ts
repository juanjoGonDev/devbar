import { describe, expect, it } from 'vitest';
import { createSerial } from '../src/main/remote/serial.js';

/**
 * One task at a time, in call order: what keeps two starts of «Control
 * remoto» (or a start and a key renewal) from interleaving while the server
 * is still opening or closing its port.
 */

/** A promise the test resolves by hand. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('src/main/remote/serial.ts', () => {
  it('runs each task only after the one before it has finished', async () => {
    const serial = createSerial();
    const order: string[] = [];
    const first = gate();

    const one = serial(async () => {
      order.push('one starts');
      await first.opened;
      order.push('one ends');
      return 'a';
    });
    const two = serial(() => {
      order.push('two starts');
      return Promise.resolve('b');
    });
    await Promise.resolve();
    expect(order).toEqual(['one starts']);
    first.open();

    await expect(Promise.all([one, two])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['one starts', 'one ends', 'two starts']);
  });

  it('keeps going after a task that failed, which still fails for its caller', async () => {
    const serial = createSerial();

    const failed = serial(() => Promise.reject(new Error('nope')));
    const next = serial(() => Promise.resolve('next'));

    await expect(failed).rejects.toThrow('nope');
    await expect(next).resolves.toBe('next');
  });
});
