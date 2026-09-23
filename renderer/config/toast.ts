/**
 * The window's single toast surface.
 *
 * `errorMessage` ships with it because every caller pairs the two: an unknown
 * thrown value only ever reaches the user through a toast.
 */

export type ShowToast = (msg: string, kind?: string) => void;

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function createToast(toastEl: HTMLElement): ShowToast {
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  return function showToast(msg: string, kind = 'ok'): void {
    toastEl.textContent = msg;
    toastEl.className = `toast ${kind}`;
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.display = 'none';
    }, 4500);
  };
}
