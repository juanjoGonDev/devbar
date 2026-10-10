import { describe, expect, it } from 'vitest';
import { saveSettings } from '../src/main/settings-save.js';
import type { GlobalSettings } from '../src/domain-types.js';
import { makeSettings } from './helpers/main-fakes.js';

/**
 * The one path that writes the global settings and applies what changes with
 * them, shared by the config window (settings:save) and «Control remoto».
 */

function harness() {
  const calls: string[] = [];
  let settings = makeSettings();
  const deps = {
    configStore: {
      saveGlobalSettings: (patch: Partial<GlobalSettings>) => {
        settings = { ...settings, ...patch };
        calls.push(`save:${JSON.stringify(patch)}`);
        return settings;
      },
    },
    applyAutostart: (enabled: boolean) => calls.push(`autostart:${enabled}`),
    refreshWindowBackgrounds: () => calls.push('repaint'),
    sendTheme: (theme: string) => calls.push(`theme:${theme}`),
    broadcast: () => calls.push('broadcast'),
  };
  return { deps, calls };
}

describe('src/main/settings-save.ts', () => {
  it('saves the patch, then applies autostart, the theme and a broadcast', () => {
    const { deps, calls } = harness();

    const next = saveSettings(deps, { autostart: true });

    expect(next.autostart).toBe(true);
    expect(calls).toEqual([
      'save:{"autostart":true}',
      'autostart:true',
      'repaint',
      'theme:auto',
      'broadcast',
    ]);
  });
});
