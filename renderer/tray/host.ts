/**
 * The services the tray SHELL hands to the pieces it renders.
 *
 * `renderer/tray.ts` owns the toast element and the render loop, and the row
 * and branch modules it renders need both: a branch switch that fails has to
 * say so, and expanding a group has to repaint the list. Importing the entry
 * point back would be a cycle, so the shell installs itself here once at
 * load — the same shape `renderer/combobox.ts` already uses for its host.
 */
export interface TrayHost {
  /** The tray's toast element (`#toast` in `tray.html`). */
  toastElement: HTMLElement;
  /** Repaints the group list from the last state the main process sent. */
  rerender: () => void;
}

let host: TrayHost | null = null;

export function setTrayHost(next: TrayHost): void {
  host = next;
}

/** Repaints the tray. Does nothing until the shell has installed itself. */
export function rerenderTray(): void {
  host?.rerender();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(msg: string, kind = 'ok'): void {
  const toastEl = host?.toastElement;
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.display = 'none';
  }, 4000);
}
