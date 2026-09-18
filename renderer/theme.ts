/**
 * Theme engine for the renderer windows. The user picks auto/light/dark in
 * settings; auto follows the OS (live). The resolved theme is published as
 * `data-theme="light|dark"` on <html>, and styles.css carries every dark
 * override behind `[data-theme="dark"]` — so the CSS has one source of
 * truth per theme and no media queries of its own.
 *
 * Call initTheme() once per window entry point; it applies the current
 * setting, follows OS changes while in auto mode, and re-applies whenever
 * main pushes a new preference on `settings:theme` (settings:save sends one,
 * so a theme change in the config window propagates to all open windows).
 */
import type { ThemePreference } from '../src/domain-types.js';

const media = window.matchMedia('(prefers-color-scheme: dark)');
let preference: ThemePreference = 'auto';

export function applyTheme(pref: ThemePreference): void {
  preference = pref;
  const resolved = pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
  document.documentElement.setAttribute('data-theme', resolved);
}

let initialized = false;
export function initTheme(): void {
  if (initialized) return;
  initialized = true;
  // Tag the running OS on <html> so CSS can adapt chrome that only belongs
  // to one platform (the inset title strip is macOS chrome — on
  // Windows/Linux the native titlebar already carries the title, and the
  // strip would duplicate it).
  document.documentElement.setAttribute('data-os', window.api.platform);
  // Apply the OS-following theme SYNCHRONOUSLY: without this, <html> has no
  // data-theme until getSettings() resolves, and the first paint falls back
  // to the light defaults — a visible flash for dark-system users.
  applyTheme('auto');
  void window.api
    .getSettings()
    .then((s) => applyTheme(s.theme ?? 'auto'))
    .catch(() => applyTheme('auto'));
  media.addEventListener('change', () => {
    if (preference === 'auto') applyTheme('auto');
  });
  // Apply the PUSHED value — no getSettings() round trip. The old
  // groups:update subscription re-read the whole config file once per
  // warn/error log line, in every open window.
  window.api.onThemeChange((theme) => applyTheme(theme ?? 'auto'));
}
