import type { RemoteEnv } from './env.js';
import { countdown, mmss } from './format.js';

/**
 * «Caduca en 0:42» and its thin bar, under the six digits the phone shows
 * while the computer decides (renderer/remote/pair-flow.ts).
 *
 * The computer sends the time its request has LEFT, not when it ends: this
 * phone's clock may be minutes — or hours — off, so the deadline is set on
 * this clock the moment the answer arrives, and only differences of it are
 * ever read. Arriving after the computer counted, it ends a hair later than
 * there, never earlier.
 *
 * At zero the computer still has the last word: it may have accepted in the
 * final second, before the phone's next poll. So the line reads
 * «Comprobando…» and the poll goes on for a few seconds more — an answer
 * then (accepted, rejected, expired) wins — and only a grace period with no
 * answer at all ends in `expired`.
 *
 * The number is not a live region: a screen reader would read it out every
 * second. The bar is decoration (aria-hidden); the expired view says the rest.
 */

const TICK_MS = 1000;
/** The bar turns to the warning colour for the last seconds. */
const ENDING_MS = 10_000;
/** How long past zero the computer's answer is still waited for. */
const GRACE_MS = 5000;

export interface ExpiryElements {
  expiry: HTMLElement;
  expiryText: HTMLElement;
  expiryBar: HTMLElement;
}

export interface ExpiryCountdown {
  /**
   * Counts `left` milliseconds down from now; `expired` runs once the grace
   * period past zero is over too. Anything but a positive number shows no
   * countdown at all.
   */
  start(left: unknown, expired: () => void): void;
  stop(): void;
}

export function createExpiryCountdown(
  env: Pick<RemoteEnv, 'now' | 'setInterval' | 'clearInterval'>,
  els: ExpiryElements,
): ExpiryCountdown {
  let timer: unknown = null;

  const stop = (): void => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };

  return {
    start: (left, expired) => {
      stop();
      const total =
        typeof left === 'number' && Number.isFinite(left) && left > 0
          ? left
          : null;
      els.expiry.hidden = total === null;
      if (total === null) return;
      const deadline = env.now() + total;
      const paint = (): void => {
        const remaining = Math.max(0, deadline - env.now());
        els.expiryText.textContent =
          remaining > 0
            ? `Caduca en ${mmss(countdown(remaining))}`
            : 'Comprobando…';
        els.expiryBar.style.width = `${(remaining / total) * 100}%`;
        els.expiry.classList.toggle('is-ending', remaining <= ENDING_MS);
      };
      paint();
      timer = env.setInterval(() => {
        if (env.now() < deadline + GRACE_MS) {
          paint();
          return;
        }
        stop();
        expired();
      }, TICK_MS);
    },
    stop,
  };
}
