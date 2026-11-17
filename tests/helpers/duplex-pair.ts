import { Duplex, type PassThrough } from 'node:stream';

/**
 * Two ends of an in-memory connection: what one writes, the other reads —
 * a socket without a network. Ending one end ends the other's input, and
 * destroying one closes the other, as a hang-up does.
 */
export function duplexPair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const make = (index: number): Duplex =>
    new Duplex({
      read() {
        // Data arrives through the other end's writes.
      },
      write(chunk: Buffer, _encoding, callback) {
        ends[1 - index]?.push(chunk);
        callback();
      },
      final(callback) {
        ends[1 - index]?.push(null);
        callback();
      },
      destroy(error, callback) {
        const other = ends[1 - index];
        if (other && !other.destroyed) other.destroy();
        callback(error);
      },
    });
  ends.push(make(0), make(1));
  return [ends[0], ends[1]];
}

/** Everything written to `stream` from now on, as text. */
export function collect(stream: Duplex | PassThrough): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer | string) => {
    text += chunk.toString();
  });
  return () => text;
}

export const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
