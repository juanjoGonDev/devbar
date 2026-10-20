/**
 * How rows are drawn, as the reader left it: wrapped or on one line, and the
 * clock absolute or relative.
 *
 * Remembered per machine in `localStorage`, read once at load. Storage can be
 * unavailable (or throw) and that must never break the window: the defaults —
 * wrapped, absolute — are simply what the window shows then.
 */
const WRAP_KEY = 'devbar.logs.wrap';
const TIME_KEY = 'devbar.logs.time';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered this time; the choice still applies to this window.
  }
}

export const rowPrefs = {
  wrap: read(WRAP_KEY) !== 'off',
  relativeTime: read(TIME_KEY) === 'relative',
};

export function setWrap(wrap: boolean): void {
  rowPrefs.wrap = wrap;
  write(WRAP_KEY, wrap ? 'on' : 'off');
}

export function setRelativeTime(relative: boolean): void {
  rowPrefs.relativeTime = relative;
  write(TIME_KEY, relative ? 'relative' : 'absolute');
}
