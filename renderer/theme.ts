/**
 * Theme engine for the renderer windows. The user picks auto/light/dark in
 * settings; auto follows the OS (live). The resolved theme is published as
 * `data-theme="light|dark"` on <html>, and styles.css carries every dark
 * override behind `[data-theme="dark"]` — so the CSS has one source of
 * truth per theme and no media queries of its own.
 *
 * Call initTheme() once per window entry point; it applies the current
 * setting, follows OS changes while in auto mode, and re-applies on every
 * groups:update broadcast (settings:save triggers one, so a theme change in
 * the config window propagates to all open windows).
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
  void window.api
    .getSettings()
    .then((s) => applyTheme(s.theme ?? 'auto'))
    .catch(() => applyTheme('auto'));
  media.addEventListener('change', () => {
    if (preference === 'auto') applyTheme('auto');
  });
  window.api.onUpdate(() => {
    void window.api
      .getSettings()
      .then((s) => applyTheme(s.theme ?? 'auto'))
      .catch(() => {});
  });
}
