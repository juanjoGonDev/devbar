import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailableUpdate } from '../src/domain-types.js';
import type { TrayColor } from '../src/ipc-contract.js';

/**
 * `src/dev/dev-ipc.ts` is the main-process half of the dev simulation panel:
 * ten `ipcMain.handle` registrations that each translate a loose payload from
 * the renderer into one call on the injected `DevHooks`. The hooks are the
 * seam that keeps this file out of packaged builds, so exercising the
 * handlers against a fake set of them is the whole module.
 */

const registry = vi.hoisted(
  () => new Map<string, (event: unknown, payload: unknown) => unknown>(),
);
const build = vi.hoisted(() => {
  const state: {
    calls: unknown[];
    result: string;
    failure: Error | string | null;
  } = {
    calls: [],
    result: 'staged.zip',
    failure: null,
  };
  return state;
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, payload: unknown) => unknown,
    ) => {
      registry.set(channel, handler);
    },
  },
  // tray-icon.ts (imported for parseTrayCount) pulls these in.
  nativeImage: { createFromBitmap: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
}));

vi.mock('../src/dev/simulate-update.js', () => ({
  buildSimulatedUpdate: (options: unknown) => {
    build.calls.push(options);
    if (build.failure !== null) {
      // A rejection that is NOT an Error is half of what this covers, so the
      // assertion is the test lying to the type system on purpose.
      const reason: Error = build.failure as Error;
      return Promise.reject(reason);
    }
    return Promise.resolve(build.result);
  },
}));

import {
  nextMinor,
  registerDevIpc,
  type DevHooks,
} from '../src/dev/dev-ipc.js';

interface Recorded {
  simulatedUpdate: (AvailableUpdate | null)[];
  trayColor: (TrayColor | null)[];
  trayCount: (number | null)[];
  banners: { title: string; body: string; options: unknown }[];
  fallbackBanners: { title: string; body: string; options: unknown }[];
  completions: { title: string; body: string }[];
  prescriptConfirms: { name: string; command: string }[];
  staged: { zipPath: string; version: string }[];
  toasts: { kind: string; message: string }[];
}

let recorded: Recorded;
let bundle: string | null;

function makeHooks(): DevHooks {
  return {
    setSimulatedUpdate: (update) => void recorded.simulatedUpdate.push(update),
    setSimulatedTrayColor: (color) => void recorded.trayColor.push(color),
    setSimulatedTrayCount: (count) => void recorded.trayCount.push(count),
    showBanner: (title, body, options) =>
      void recorded.banners.push({ title, body, options }),
    showFallbackBanner: (title, body, options) =>
      void recorded.fallbackBanners.push({ title, body, options }),
    showCompletionNotification: (title, body) =>
      void recorded.completions.push({ title, body }),
    openPrescriptConfirm: (name, command) =>
      void recorded.prescriptConfirms.push({ name, command }),
    installedBundle: () => bundle,
    updatesDir: () => '/tmp/devbar-updates',
    stageLocalUpdate: (zipPath, version) => {
      recorded.staged.push({ zipPath, version });
      return Promise.resolve();
    },
    toast: (kind, message) => void recorded.toasts.push({ kind, message }),
    currentVersion: () => '0.9.2',
  };
}

function fire(channel: string, payload?: unknown): Promise<unknown> {
  const handler = registry.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, payload));
}

describe('src/dev/dev-ipc.ts', () => {
  beforeEach(() => {
    registry.clear();
    build.calls.length = 0;
    build.result = 'staged.zip';
    build.failure = null;
    bundle = '/Applications/DevBar.app';
    recorded = {
      simulatedUpdate: [],
      trayColor: [],
      trayCount: [],
      banners: [],
      fallbackBanners: [],
      completions: [],
      prescriptConfirms: [],
      staged: [],
      toasts: [],
    };
    registerDevIpc(makeHooks());
  });

  describe('nextMinor', () => {
    it.each([
      ['0.9.2', '0.10.0'],
      ['1.2.3', '1.3.0'],
      ['10.0.0', '10.1.0'],
    ])('bumps the minor of %s', (version, expected) => {
      expect(nextMinor(version)).toBe(expected);
    });

    it.each([
      ['too few parts', '1.2'],
      ['too many parts', '1.2.3.4'],
      ['not numeric', 'a.b.c'],
      ['empty', ''],
    ])('falls back to 99.0.0 for a %s version', (_label, version) => {
      expect(nextMinor(version)).toBe('99.0.0');
    });
  });

  describe('registration', () => {
    it('claims exactly the dev channels the preload bridge invokes', () => {
      expect([...registry.keys()].sort()).toEqual([
        'dev:clearUpdate',
        'dev:simulateBanner',
        'dev:simulateFallbackBanner',
        'dev:simulatePrescriptConfirm',
        'dev:simulateRealUpdate',
        'dev:simulateSuccess',
        'dev:simulateToast',
        'dev:simulateTrayColor',
        'dev:simulateTrayCount',
        'dev:simulateUpdate',
      ]);
    });
  });

  describe('dev:simulateUpdate', () => {
    it('simulates the version the panel asked for', async () => {
      const result = await fire('dev:simulateUpdate', { version: '3.4.5' });

      expect(result).toEqual({ ok: true, version: '3.4.5' });
      expect(recorded.simulatedUpdate).toEqual([
        {
          version: '3.4.5',
          url: 'https://github.com/juanjoGonDev/devbar/releases/tag/v3.4.5',
          dmgUrl: null,
          zipUrl: null,
          setupUrl: null,
          appImageUrl: null,
          debUrl: null,
        },
      ]);
    });

    it.each([
      ['an absent payload', undefined],
      ['an empty version', { version: '' }],
      ['a non-string version', { version: 7 }],
      ['a payload that is not an object', 'nonsense'],
    ])('bumps the running version for %s', async (_label, payload) => {
      const result = await fire('dev:simulateUpdate', payload);

      expect(result).toEqual({ ok: true, version: '0.10.0' });
      expect(recorded.simulatedUpdate[0]?.version).toBe('0.10.0');
    });
  });

  describe('dev:simulateRealUpdate', () => {
    it('refuses outside an installed bundle, without touching the real update state', async () => {
      bundle = null;

      const result = await fire('dev:simulateRealUpdate');

      expect(result).toMatchObject({ ok: false });
      expect(recorded.simulatedUpdate).toEqual([]);
      expect(recorded.staged).toEqual([]);
      expect(build.calls).toEqual([]);
    });

    it('builds the bumped bundle and stages it through the production path', async () => {
      const result = await fire('dev:simulateRealUpdate');

      expect(result).toEqual({ ok: true, version: '0.10.0' });
      expect(build.calls).toEqual([
        {
          bundlePath: '/Applications/DevBar.app',
          workDir: '/tmp/devbar-updates',
          version: '0.10.0',
        },
      ]);
      expect(recorded.staged).toEqual([
        { zipPath: 'staged.zip', version: '0.10.0' },
      ]);
    });

    it('reports the build failure instead of throwing at the renderer', async () => {
      build.failure = new Error('codesign refused');

      const result = await fire('dev:simulateRealUpdate');

      expect(result).toEqual({ ok: false, error: 'codesign refused' });
      expect(recorded.staged).toEqual([]);
    });

    it('stringifies a rejection that is not an Error', async () => {
      build.failure = 'plain string rejection';

      const result = await fire('dev:simulateRealUpdate');

      expect(result).toEqual({ ok: false, error: 'plain string rejection' });
    });
  });

  describe('dev:clearUpdate', () => {
    it('hands control back to the real update check', async () => {
      const result = await fire('dev:clearUpdate');

      expect(result).toEqual({ ok: true });
      expect(recorded.simulatedUpdate).toEqual([null]);
    });
  });

  describe('dev:simulateTrayColor', () => {
    it.each(['stopped', 'running', 'warn', 'error'] as const)(
      'forces the %s color',
      async (color) => {
        const result = await fire('dev:simulateTrayColor', { color });

        expect(result).toEqual({ ok: true, color });
        expect(recorded.trayColor).toEqual([color]);
      },
    );

    it.each([
      ['an unknown color', { color: 'purple' }],
      ['no color at all', {}],
      ['an explicit null', { color: null }],
    ])('releases the override for %s', async (_label, payload) => {
      const result = await fire('dev:simulateTrayColor', payload);

      expect(result).toEqual({ ok: true, color: null });
      expect(recorded.trayColor).toEqual([null]);
    });
  });

  describe('dev:simulateTrayCount', () => {
    it.each([
      ['a number', { count: 14 }, 14],
      ['a numeric string', { count: '7' }, 7],
      ['a count above the ceiling', { count: 100_000 }, 9999],
      ['null', { count: null }, null],
      ['a negative count', { count: -1 }, null],
      ['a fractional count', { count: 1.5 }, null],
    ])('forces %s', async (_label, payload, expected) => {
      const result = await fire('dev:simulateTrayCount', payload);

      expect(result).toEqual({ ok: true, count: expected });
      expect(recorded.trayCount).toEqual([expected]);
    });
  });

  describe('dev:simulateBanner', () => {
    it('adds a call to action only when the panel asked for one', async () => {
      await fire('dev:simulateBanner', { cta: true });
      await fire('dev:simulateBanner', { cta: false });

      expect(recorded.banners).toEqual([
        {
          title: 'DevBar — prueba',
          body: 'Aviso de prueba con acción.',
          options: { cta: { label: 'Ver', action: 'open-about' } },
        },
        {
          title: 'DevBar — prueba',
          body: 'Aviso de prueba sin acción.',
          options: undefined,
        },
      ]);
    });

    it('goes through the real banner path, never the fallback', async () => {
      const result = await fire('dev:simulateBanner', { cta: true });

      expect(result).toEqual({ ok: true });
      expect(recorded.fallbackBanners).toEqual([]);
    });
  });

  describe('dev:simulateFallbackBanner', () => {
    it('bypasses the native attempt and keeps its own copy', async () => {
      await fire('dev:simulateFallbackBanner', { cta: true });
      await fire('dev:simulateFallbackBanner', {});

      expect(recorded.fallbackBanners).toEqual([
        {
          title: 'DevBar — reserva',
          body: 'Banner propio con acción.',
          options: { cta: { label: 'Ver', action: 'open-about' } },
        },
        {
          title: 'DevBar — reserva',
          body: 'Banner propio sin acción.',
          options: undefined,
        },
      ]);
      expect(recorded.banners).toEqual([]);
    });
  });

  describe('dev:simulateSuccess', () => {
    it('goes through the completion gate rather than the plain banner', async () => {
      const result = await fire('dev:simulateSuccess');

      expect(result).toEqual({ ok: true });
      expect(recorded.completions).toEqual([
        {
          title: 'DevBar — prueba',
          body: 'Notificación de éxito simulada.',
        },
      ]);
      expect(recorded.banners).toEqual([]);
    });
  });

  describe('dev:simulatePrescriptConfirm', () => {
    it('opens the confirmation modal with a runnable sample script', async () => {
      const result = await fire('dev:simulatePrescriptConfirm');

      expect(result).toEqual({ ok: true });
      expect(recorded.prescriptConfirms).toEqual([
        { name: 'Script de prueba', command: 'echo "hola desde dev"' },
      ]);
    });
  });

  describe('dev:simulateToast', () => {
    it.each([
      ['error', 'error', 'Toast de error simulado.'],
      ['ok', 'ok', 'Toast simulado.'],
    ])(
      'sends the %s toast with its own copy',
      async (kind, expectedKind, message) => {
        await fire('dev:simulateToast', { kind });

        expect(recorded.toasts).toEqual([{ kind: expectedKind, message }]);
      },
    );

    it.each([
      ['an absent kind', {}],
      ['a non-string kind', { kind: 3 }],
    ])('defaults to ok for %s', async (_label, payload) => {
      await fire('dev:simulateToast', payload);

      expect(recorded.toasts).toEqual([
        { kind: 'ok', message: 'Toast simulado.' },
      ]);
    });
  });
});
