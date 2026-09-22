import { describe, expect, it, vi } from 'vitest';
import {
  createDevHooks,
  registerDevPanel,
  type DevPanelDeps,
} from '../src/main/dev-panel.js';
import type { DevHooks } from '../src/dev/dev-ipc.js';

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
    openPrescriptConfirm: () => calls.push('openPrescriptConfirm'),
    toast: () => calls.push('toast'),
    installedBundle: () => '/Applications/DevBar.app',
    updatesDir: () => '/home/updates',
    stageFromZip: () => Promise.resolve(),
    removeFile: () => calls.push('removeFile'),
    stagedVersion: () => '1.3.0',
    pruneStagedUpdates: (keep) => calls.push(`prune:${keep}`),
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
      expect(d.calls).toEqual([
        'setSimulatedTrayColor',
        'showBanner',
        'showFallbackBanner',
        'showCompletionNotification',
        'openPrescriptConfirm',
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
});
