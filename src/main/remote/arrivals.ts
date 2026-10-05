/**
 * When a linked device connecting is worth a desktop notice: its first
 * connection since DevBar started, or one after at least ten minutes of
 * continuous absence. A reload, a tab switch or an event stream that
 * reconnects a moment later is the same visit, and says nothing.
 *
 * In memory only. A device's last sign of presence — an arrival, or its last
 * stream closing — is what absence is measured from.
 */

const QUIET_MS = 10 * 60_000;

export interface Arrivals {
  /**
   * The device proved itself or opened its stream; true when that is an
   * arrival to announce. `connected`: it already held a stream.
   */
  arrived(deviceId: string, connected: boolean): boolean;
  /** The device's last stream closed. */
  left(deviceId: string): void;
}

export function createArrivals(deps: {
  now(): number;
  quietMs?: number;
}): Arrivals {
  const quietMs = deps.quietMs ?? QUIET_MS;
  const lastPresent = new Map<string, number>();
  return {
    arrived: (deviceId, connected) => {
      const now = deps.now();
      const previous = lastPresent.get(deviceId);
      lastPresent.set(deviceId, now);
      if (connected) return false;
      return previous === undefined || now - previous >= quietMs;
    },
    left: (deviceId) => {
      lastPresent.set(deviceId, deps.now());
    },
  };
}
