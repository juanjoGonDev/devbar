/**
 * The icons picked lately, newest first, per machine (localStorage). Values
 * are what an icon field stores — a Lucide name or `img:<id>` — so the
 * picker resolves each against what still exists before showing it.
 */

const RECENT_ICONS_KEY = 'devbar.recentIcons';
const RECENT_ICONS_MAX = 20;

export function getRecentIcons(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(RECENT_ICONS_KEY) || '[]',
    ) as unknown;
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .slice(0, RECENT_ICONS_MAX)
      : [];
  } catch {
    return [];
  }
}

export function pushRecentIcon(value: string): void {
  const next = [value, ...getRecentIcons().filter((e) => e !== value)].slice(
    0,
    RECENT_ICONS_MAX,
  );
  try {
    localStorage.setItem(RECENT_ICONS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — recents just won't persist */
  }
}
