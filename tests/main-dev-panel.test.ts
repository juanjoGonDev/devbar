import { describe, expect, it, vi } from 'vitest';
import {
  createDevHooks,
  createFixtureHost,
  fixtureEnvironment,
  registerDevPanel,
  type DevPanelDeps,
} from '../src/main/dev-panel.js';
import type { DevHooks } from '../src/dev/dev-ipc.js';

const fixtures: DevPanelDeps['fixtures'] = {
  environment: () => ({
    platform: 'linux',
    execPath: '/opt/devbar',
    tmpDir: '/tmp',
    repoPath: null,
  }),
  setOverlay: () => undefined,
  processIds: () => [],
  stop: () => Promise.resolve({ ok: true }),
  removeState: () => undefined,
  refresh: () => undefined,
};

function deps(overrides: Partial<DevPanelDeps> = {}) {
  const calls: string[] = [];
  const base: DevPanelDeps = {
    currentVersion: () => '1.2.0',
    setSimulatedUpdate: () => calls.push('setSimulatedUpdate'),
    setSimulatedTrayColor: () => calls.push('setSimulatedTrayColor'),
    setSimulatedTrayCount: () => calls.push('setSimulatedTrayCount'),
    applyTrayTitleCount: () => calls.push('applyTrayTitleCount'),
    refreshTrayIcon: () => calls.push('refreshTrayIcon'),
    broadcastUpdateStatus: () => calls.push('broadcastUpdateStatus'),
    showBanner: () => calls.push('showBanner'),
    showFallbackBanner: () => calls.push('showFallbackBanner'),
    showCompletionNotification: () => calls.push('showCompletionNotification'),
    showConfirmModal: (script, origin, groupName) => {
      calls.push(
        `confirm:${script.name}:${script.command}:${origin}:${groupName}`,
      );
      return Promise.resolve(true);
    },
    toast: () => calls.push('toast'),
    installedBundle: () => '/Applications/DevBar.app',
    updatesDir: () => '/home/updates',
    stageFromZip: () => Promise.resolve(),
    removeFile: () => calls.push('removeFile'),
    stagedVersion: () => '1.3.0',
    pruneStagedUpdates: (keep) => calls.push(`prune:${keep}`),
    fixtures,
    ...overrides,
  };
  return { base, calls };
}

describe('src/main/dev-panel.ts', () => {
  describe('createDevHooks', () => {
    it('repaints the tray and re-broadcasts after a simulated update', () => {
      const d = deps();
      createDevHooks(d.base).setSimulatedUpdate(null);
      expect(d.calls).toEqual([
        'setSimulatedUpdate',
        'refreshTrayIcon',
        'broadcastUpdateStatus',
      ]);
    });

    it('applies a forced count to the title before repainting', () => {
      const d = deps();
      createDevHooks(d.base).setSimulatedTrayCount(3);
      expect(d.calls).toEqual([
        'setSimulatedTrayCount',
        'applyTrayTitleCount',
        'refreshTrayIcon',
      ]);
    });

    it('forwards the simple delegations', () => {
      const d = deps();
      const hooks = createDevHooks(d.base);
      hooks.setSimulatedTrayColor('error');
      hooks.showBanner('t', 'b');
      hooks.showFallbackBanner('t', 'b');
      hooks.showCompletionNotification('t', 'b');
      hooks.openPrescriptConfirm('vpn', 'connect');
      hooks.toast('ok', 'hi');
      expect(hooks.currentVersion()).toBe('1.2.0');
      expect(hooks.installedBundle()).toBe('/Applications/DevBar.app');
      expect(hooks.updatesDir()).toBe('/home/updates');
      expect(hooks.fixtures).toBe(fixtures);
      expect(d.calls).toEqual([
        'setSimulatedTrayColor',
        'showBanner',
        'showFallbackBanner',
        'showCompletionNotification',
        'confirm:vpn:connect:interactive:null',
        'toast',
      ]);
    });

    it('prunes by what IS staged after a local staging run', async () => {
      const d = deps();
      await createDevHooks(d.base).stageLocalUpdate('/tmp/a.zip', '1.3.0');
      expect(d.calls).toEqual(['removeFile', 'prune:1.3.0']);
    });

    it('still cleans up when staging fails, and prunes nothing with no staged copy', async () => {
      const d = deps({
        stageFromZip: () => Promise.reject(new Error('bad zip')),
        stagedVersion: () => null,
      });
      await expect(
        createDevHooks(d.base).stageLocalUpdate('/tmp/a.zip', '1.3.0'),
      ).rejects.toThrow('bad zip');
      expect(d.calls).toEqual(['removeFile']);
    });
  });

  describe('registerDevPanel', () => {
    it('does nothing when the panel did not ship with this build', () => {
      const load = vi.fn();
      registerDevPanel(false, deps().base, load as never);
      expect(load).not.toHaveBeenCalled();
    });

    it('hands the hooks to the panel when it did', async () => {
      const received: DevHooks[] = [];
      registerDevPanel(true, deps().base, () =>
        Promise.resolve({
          registerDevIpc: (hooks: DevHooks) => received.push(hooks),
        }),
      );
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]?.currentVersion()).toBe('1.2.0');
    });

    it('swallows a missing module, which is the packaged-build case', async () => {
      const load = vi.fn(() => Promise.reject(new Error('not found')));
      registerDevPanel(true, deps().base, load);
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
    });
  });

  describe('createFixtureHost', () => {
    it('hands the overlay the process manager and the repaint it needs', async () => {
      const calls: string[] = [];
      const host = createFixtureHost({
        app: { isPackaged: true, getAppPath: () => '/app' },
        pathExists: () => true,
        setOverlay: (groups) => calls.push(`overlay:${groups?.length ?? 0}`),
        processManager: {
          allStates: () => [{ id: 'cmd:g:a' }, { id: 'act:g:b' }],
          stop: (id) => {
            calls.push(`stop:${id}`);
            return Promise.resolve({ ok: true });
          },
          removeState: (id) => calls.push(`remove:${id}`),
        },
        refresh: () => calls.push('refresh'),
      });

      expect(host.processIds()).toEqual(['cmd:g:a', 'act:g:b']);
      await host.stop('cmd:g:a');
      host.removeState('cmd:g:a');
      host.setOverlay(null);
      host.refresh();
      expect(calls).toEqual([
        'stop:cmd:g:a',
        'remove:cmd:g:a',
        'overlay:0',
        'refresh',
      ]);
      expect(host.environment()).toMatchObject({
        platform: process.platform,
        execPath: process.execPath,
        repoPath: null,
      });
    });
  });

  describe('fixtureEnvironment', () => {
    const base = {
      platform: 'darwin' as const,
      execPath: '/repo/node_modules/electron/dist/Electron',
      tmpDir: '/tmp',
      appPath: '/repo',
    };

    it('points a fixture at the checkout itself in a dev run', () => {
      expect(
        fixtureEnvironment({
          ...base,
          isPackaged: false,
          exists: (target) => target === '/repo/.git',
        }),
      ).toEqual({
        platform: 'darwin',
        execPath: base.execPath,
        tmpDir: '/tmp',
        repoPath: '/repo',
      });
    });

    it('has no repository inside an installed app', () => {
      expect(
        fixtureEnvironment({ ...base, isPackaged: true, exists: () => true })
          .repoPath,
      ).toBeNull();
    });

    it('has none when the dev run is not a checkout', () => {
      expect(
        fixtureEnvironment({ ...base, isPackaged: false, exists: () => false })
          .repoPath,
      ).toBeNull();
    });
  });
});
