/**
 * The words and numbers of the «Control remoto» section: countdowns, the
 * verification code and how long ago a device was last seen. Whether one is
 * connected right now is not guessed from that: main reports it (an open
 * event stream).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DATE = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "482913" → "482 913": easier to compare at a glance with the phone. */
export function formatVerificationCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** Milliseconds left → "m:ss", rounded up so 0:00 means really over. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatDate(timestamp: number): string {
  return DATE.format(timestamp);
}

/** "hace 5 min", "hace 3 h", "hace 2 días" or, after a week, the date. */
export function lastSeen(lastSeenAt: number, now: number): string {
  const age = now - lastSeenAt;
  if (age < MINUTE) return 'hace un momento';
  if (age < HOUR) return `hace ${Math.floor(age / MINUTE)} min`;
  if (age < DAY) return `hace ${Math.floor(age / HOUR)} h`;
  if (age < 7 * DAY) {
    const days = Math.floor(age / DAY);
    return `hace ${days} día${days === 1 ? '' : 's'}`;
  }
  return formatDate(lastSeenAt);
}
