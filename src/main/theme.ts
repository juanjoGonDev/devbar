import type { ThemePreference } from '../domain-types.js';

/**
 * The user's theme preference resolved against the OS, and the opaque window
 * background that follows from it. Both window creation and the post-change
 * repaint read the same two functions, so a new window and an already-open one
 * can never disagree about the colour.
 */

/** Resolved theme (user preference, falling back to the OS in auto mode). */
export function resolvedThemeIsDark(
  preference: ThemePreference,
  osPrefersDark: boolean,
): boolean {
  if (preference === 'light') return false;
  if (preference === 'dark') return true;
  return osPrefersDark;
}

export function themeWindowBackground(isDark: boolean): string {
  return isDark ? '#1e1e1e' : '#f5f5f7';
}
