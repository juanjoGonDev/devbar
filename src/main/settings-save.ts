import type { GlobalSettings, ThemePreference } from '../domain-types.js';

/**
 * Writing the global settings and applying what changes with them: the login
 * item, the window backgrounds, the theme push and a broadcast. One path for
 * every surface that saves them — the config window (settings:save) and a
 * phone through «Control remoto» — so neither can forget a side effect.
 */

export interface SettingsSaveDeps {
  configStore: {
    saveGlobalSettings(patch: Partial<GlobalSettings>): GlobalSettings;
  };
  applyAutostart: (enabled: boolean) => void;
  refreshWindowBackgrounds: () => void;
  sendTheme: (theme: ThemePreference) => void;
  broadcast: () => void;
}

export function saveSettings(
  deps: SettingsSaveDeps,
  patch: Partial<GlobalSettings>,
): GlobalSettings {
  const next = deps.configStore.saveGlobalSettings(patch);
  deps.applyAutostart(next.autostart);
  if (next.theme !== undefined) {
    deps.refreshWindowBackgrounds();
    // Push the resolved preference on its OWN channel. Renderers used to
    // re-read the settings off the `groups:update` broadcast, which fires
    // once per non-silenced warn/error line, in every open window — a
    // synchronous full config read + schema validation per line on the main
    // thread.
    deps.sendTheme(next.theme);
  }
  deps.broadcast();
  return next;
}
