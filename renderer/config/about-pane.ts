/** Everyday names for Node's `process.platform` values. */
const OS_NAMES: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/**
 * The line under the About hero: "Versión 0.11.1 · macOS arm64". Empty
 * without a version, so a failed read leaves the line blank rather than
 * claiming "Versión ".
 */
export function aboutVersionLine(
  version: string,
  platform: string,
  arch: string | undefined,
): string {
  if (!version) return '';
  const os = OS_NAMES[platform] ?? platform;
  return `Versión ${version} · ${arch ? `${os} ${arch}` : os}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * When the last update check ran, relative to `now`: "hoy a las 14:41",
 * "ayer a las 09:05" or "el 03/10/2026 a las 23:59". Null when nothing was
 * ever checked (or main sent something that is not a date).
 */
export function lastCheckLabel(
  at: string | number | Date | null | undefined,
  now: Date,
): string | null {
  if (at === null || at === undefined) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const time = `a las ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
  if (sameDay(when, now)) return `hoy ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(when, yesterday)) return `ayer ${time}`;
  return `el ${pad2(when.getDate())}/${pad2(when.getMonth() + 1)}/${when.getFullYear()} ${time}`;
}

/** GitHub's generated notes credit each PR: " by @user in https://…". */
const PR_CREDIT = /\s+by\s+@\S+\s+in\s+https?:\/\/\S+$/;

/** The bullet points of one release's notes, without GitHub's PR credits. */
export function releaseHighlights(body: string | null | undefined): string[] {
  if (!body) return [];
  const items: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const bullet = raw.trim().match(/^[*-]\s+(.*)$/);
    const text = bullet?.[1]?.replace(PR_CREDIT, '').trim();
    if (text) items.push(text);
  }
  return items;
}
