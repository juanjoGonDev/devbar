import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/config-store/custom-icons-store.ts` — the uploaded-image library,
 * through the real `electron-store` (only `electron` is faked).
 */

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  home: '',
  userData: '',
  version: '0.10.0',
}));

vi.mock('electron', () => {
  const app = {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: (name: string) =>
      name === 'home' ? electronState.home : electronState.userData,
    getVersion: () => electronState.version,
  };
  const electron = { app, ipcMain: { on: () => undefined }, shell: {} };
  return { ...electron, default: electron };
});

import { configStoreHarness } from './helpers/config-store.js';

const harness = configStoreHarness(electronState);

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const icon = (id: string, name = id) => ({ id, name, dataUrl: PNG });

describe('custom icon library', () => {
  afterEach(() => harness.cleanup());

  it('starts empty and keeps what is added across sessions', async () => {
    const first = await harness.open();
    expect(first.listCustomIcons()).toEqual([]);
    expect(first.addCustomIcon(icon('abc123', 'logo'))).toEqual({
      icon: icon('abc123', 'logo'),
      added: true,
    });
    const second = await harness.open({ home: harness.home() });
    expect(second.listCustomIcons()).toEqual([icon('abc123', 'logo')]);
  });

  it('dedupes a re-upload of the same image onto the stored one', async () => {
    const store = await harness.open();
    store.addCustomIcon(icon('abc123', 'first'));
    expect(store.addCustomIcon(icon('abc123', 'second'))).toEqual({
      icon: icon('abc123', 'first'),
      added: false,
    });
    expect(store.listCustomIcons()).toHaveLength(1);
  });

  it('refuses to grow past the cap', async () => {
    const store = await harness.open({
      seed: {
        customIcons: Array.from({ length: 200 }, (_, i) =>
          icon(`id${String(i).padStart(6, '0')}`),
        ),
      },
    });
    expect(() => store.addCustomIcon(icon('abcdef'))).toThrow(/200/);
  });

  it('deletes an icon and leaves references to fall back', async () => {
    const store = await harness.open();
    store.addCustomIcon(icon('abc123'));
    store.saveGroup({ id: 'g1', name: 'api', path: '/x', icon: 'img:abc123' });
    store.deleteCustomIcon('abc123');
    expect(store.listCustomIcons()).toEqual([]);
    // The reference stays: an unknown id renders the default icon, and
    // uploading the same image again brings it back.
    expect(store.getGroup('g1')?.icon).toBe('img:abc123');
  });

  it('drops malformed entries a hand-edited file carries', async () => {
    const store = await harness.open({
      seed: {
        customIcons: [
          icon('abc123'),
          {
            id: 'svg123',
            name: 'x',
            dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
          },
        ],
      },
    });
    expect(store.listCustomIcons()).toEqual([icon('abc123')]);
  });

  it('exports only the icons the configuration references', async () => {
    const store = await harness.open();
    store.addCustomIcon(icon('abc123'));
    store.addCustomIcon(icon('def456'));
    store.saveGroup({
      id: 'g1',
      name: 'api',
      path: '/x',
      icon: 'img:def456',
      iconColor: '#22c55e',
    });
    const exported = store.exportConfig();
    expect(exported.customIcons).toEqual([icon('def456')]);
    expect(exported.groups[0]?.iconColor).toBe('#22c55e');
  });

  it('adds imported icons to the library on replace, keeping local ones', async () => {
    const store = await harness.open();
    store.addCustomIcon(icon('abc123', 'local'));
    store.replaceConfig({
      version: 4,
      groups: [],
      preSteps: [],
      globalSettings: {},
      customIcons: [icon('abc123', 'imported'), icon('def456')],
    });
    expect(store.listCustomIcons()).toEqual([
      icon('abc123', 'local'),
      icon('def456'),
    ]);
  });
});
