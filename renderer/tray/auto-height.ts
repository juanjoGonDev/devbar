/**
 * Keeps the tray popover as tall as its content while it is open.
 *
 * The height used to be sent only after a full state render, so anything that
 * changed the DOM on its own — the update chip, the download progress, a
 * banner, a toast-sized row — left the popover at its old size until the next
 * show. Now every DOM change under `root` schedules one measurement on the
 * next animation frame (a burst collapses into one), and only a height that
 * differs from the last one sent crosses IPC.
 *
 * Loop-free by construction: it measures the CONTENT (`measure`), never the
 * window, and it does not listen to window resizes — the resize it causes
 * cannot schedule another one.
 */
export interface AutoHeightOptions {
  /** The subtree whose changes can move the content height. */
  root: Node;
  /** The natural content height, independent of the window's current size. */
  measure: () => number;
  /** Hands a new height to the main process. */
  send: (height: number) => void;
  /** True while something else (an open dropdown) owns the height. */
  isSuspended: () => boolean;
  frame?: (run: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface AutoHeight {
  /**
   * Measures on the next frame. `force` resends even an unchanged height:
   * something other than this module (a dropdown) resized the window.
   */
  schedule: (force?: boolean) => void;
  disconnect: () => void;
}

export function installAutoHeight(options: AutoHeightOptions): AutoHeight {
  const frame =
    options.frame ?? ((run: () => void) => requestAnimationFrame(run));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  let pending = 0;
  let forced = false;
  let lastSent: number | null = null;
  let connected = true;

  function schedule(force = false): void {
    if (!connected) return;
    forced ||= force;
    if (pending) cancelFrame(pending);
    pending = frame(() => {
      pending = 0;
      if (options.isSuspended()) return;
      const height = options.measure();
      if (!forced && height === lastSent) return;
      forced = false;
      lastSent = height;
      options.send(height);
    });
  }

  const observer = new MutationObserver(() => schedule());
  observer.observe(options.root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  return {
    schedule,
    disconnect(): void {
      connected = false;
      observer.disconnect();
      if (pending) cancelFrame(pending);
      pending = 0;
    },
  };
}
