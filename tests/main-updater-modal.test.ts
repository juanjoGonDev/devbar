import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { harness, update, updatesDir } from './helpers/updater-harness.js';

/**
 * The install modal and what it owns: once a staged copy is announced, the
 * modal asks about it and nothing (a newer release, a phone, a dev-panel
 * simulation, a prune) may change or remove what it asks about meanwhile.
 */
describe('src/main/updater.ts — install modal', () => {
  it('asks with the install modal once the download is ready, and installs nothing until answered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let answer: (yes: boolean) => void = () => undefined;
    const h = harness({
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    expect(h.calls, 'nothing while the modal waits').not.toContain('spawnSwap');
    answer(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      h.calls.filter(
        (call) =>
          call === 'spawnSwap' ||
          call === 'markUpdateExit' ||
          call.startsWith('quit:'),
      ),
      '«Ahora no» must leave the update waiting',
    ).toEqual([]);
    expect(h.updater.status().phase).toMatchObject({
      state: 'ready-to-install',
    });
    expect(h.notices).toEqual(['v1.3.0 lista. Reinicia para instalarla.']);
    expect(h.banners).toEqual([]);
    log.mockRestore();
  });

  it('restarts and installs once the modal is answered yes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness();
    h.confirm.answer = true;
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.calls).toContain('quit:200'));
    expect(h.calls).toContain('spawnSwap');
    log.mockRestore();
  });

  it('opens no second modal while one is still waiting', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness({
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>(() => undefined);
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    await expect(h.updater.applyUpdate()).resolves.toEqual({
      ok: false,
      busy: true,
    });
    expect(h.asked).toHaveLength(1);
    log.mockRestore();
  });

  it('starts a single swap when the phone installs while the modal waits', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let answer: (yes: boolean) => void = () => undefined;
    const h = harness({
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    await expect(h.updater.installStagedHeadless()).resolves.toMatchObject({
      ok: true,
      quitting: true,
    });
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.filter((call) => call === 'spawnSwap')).toHaveLength(1);
    log.mockRestore();
  });

  it('keeps the download the open modal asks about when a newer release turns up', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let answer: (yes: boolean) => void = () => undefined;
    let latest = update;
    const h = harness({
      checkForUpdate: () => Promise.resolve(latest),
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).not.toContain(`stage:${path.join(updatesDir, '1.4.0')}`);
    expect(h.dirs.get(updatesDir)).toContain('1.3.0');
    expect(h.updater.staged()?.version).toBe('1.3.0');
    answer(true);
    await vi.waitFor(() => expect(h.calls).toContain('spawnSwap'));
    log.mockRestore();
  });

  it('refuses a simulated staging while the modal waits, keeping its copy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness({
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>(() => undefined);
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    await expect(
      h.updater.stageFromZip('/tmp/DevBar.zip', {
        ...update,
        version: '1.4.0',
      }),
    ).rejects.toThrow(/aviso de instalación/);
    expect(h.calls).not.toContain('extract:/tmp/DevBar.zip');
    expect(h.updater.staged()?.version).toBe('1.3.0');
    log.mockRestore();
  });

  it('keeps the release the modal asks about when a simulation tries to replace it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness({
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>(() => undefined);
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    expect(() =>
      h.updater.setSimulatedUpdate({ ...update, version: '1.4.0' }),
    ).toThrow(/aviso de instalación/);
    expect(() => h.updater.setSimulatedUpdate(null)).toThrow(
      /aviso de instalación/,
    );
    expect(h.updater.available()?.version).toBe('1.3.0');
    expect(h.updater.canInstallStaged(), 'a phone can still install').toBe(
      true,
    );
    log.mockRestore();
  });

  it('lets the phone install what the modal asks about after a newer release turns up', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let latest = update;
    const h = harness({
      checkForUpdate: () => Promise.resolve(latest),
      confirmInstall: (version) => {
        h.asked.push(version);
        return new Promise<boolean>(() => undefined);
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    expect(h.updater.available()?.version).toBe('1.3.0');
    expect(h.updater.status().phase).toMatchObject({
      state: 'ready-to-install',
      version: '1.3.0',
    });
    expect(h.updater.canInstallStaged()).toBe(true);
    await expect(h.updater.installStagedHeadless()).resolves.toMatchObject({
      ok: true,
      quitting: true,
    });
    log.mockRestore();
  });

  it('leaves the release as it was when the simulated copy fails to unpack', async () => {
    const h = harness({
      extractUpdate: () => Promise.reject(new Error('bad zip')),
    });
    await expect(
      h.updater.stageFromZip('/tmp/DevBar.zip', {
        ...update,
        version: '1.4.0',
      }),
    ).rejects.toThrow('bad zip');
    expect(h.updater.available()).toBeNull();
    expect(h.updater.staged()).toBeNull();
  });

  it('keeps a real download out while a simulated copy unpacks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let unpack: () => void = () => undefined;
    const h = harness({
      extractUpdate: (input) =>
        new Promise((resolve) => {
          unpack = () =>
            resolve({ version: input.version, appPath: '/staged-sim' });
        }),
    });
    const staging = h.updater.stageFromZip('/tmp/DevBar.zip', {
      ...update,
      version: '1.4.0',
    });
    await h.updater.runUpdateCheck();
    expect(h.calls, 'no real download while it unpacks').not.toContain(
      'download',
    );
    unpack();
    await staging;
    expect(h.updater.staged()?.version).toBe('1.4.0');
    expect(h.updater.available()?.version).toBe('1.4.0');
    log.mockRestore();
  });

  it('refuses a simulated staging while a real download runs', async () => {
    const h = harness({
      downloadFile: () => new Promise<string>(() => undefined),
    });
    await h.updater.runUpdateCheck();
    await expect(
      h.updater.stageFromZip('/tmp/DevBar.zip', update),
    ).rejects.toThrow(/descarga en curso/);
    expect(h.updater.available(), 'nothing published').toEqual(update);
    expect(h.calls).not.toContain('extract:/tmp/DevBar.zip');
    expect(h.asked).toEqual([]);
  });

  it('ends on the newer release, and stages it, when one turned up mid-download', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let latest = update;
    let finish: () => void = () => undefined;
    const h = harness({
      checkForUpdate: () => Promise.resolve(latest),
      downloadFile: (_url, dest) => {
        h.calls.push('download');
        return new Promise<string>((resolve) => {
          finish = () => resolve(dest);
        });
      },
    });
    await h.updater.runUpdateCheck();
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    finish();
    await vi.waitFor(() =>
      expect(h.calls.filter((call) => call === 'download')).toHaveLength(2),
    );
    expect(h.notices, 'no ready notice for the superseded copy').toEqual([]);
    expect(h.asked).toEqual([]);
    log.mockRestore();
  });

  it('still stages the newer release a manual check asked for when the first download fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let latest = update;
    let failFirst: (reason: Error) => void = () => undefined;
    const h = harness({
      autoUpdate: () => false,
      checkForUpdate: () => Promise.resolve(latest),
      downloadFile: () => {
        h.calls.push('download');
        return h.calls.filter((call) => call === 'download').length === 1
          ? new Promise<string>((_resolve, reject) => {
              failFirst = reject;
            })
          : new Promise<string>(() => undefined);
      },
    });
    await h.updater.runUpdateCheck({ manual: true });
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck({ manual: true });
    failFirst(new Error('network down'));
    await vi.waitFor(() =>
      expect(h.calls.filter((call) => call === 'download')).toHaveLength(2),
    );
    warn.mockRestore();
    error.mockRestore();
  });

  it('keeps a manual request when a later automatic check finds the same release', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let auto = true;
    let latest = update;
    let finish: () => void = () => undefined;
    const h = harness({
      autoUpdate: () => auto,
      checkForUpdate: () => Promise.resolve(latest),
      downloadFile: (_url, dest) => {
        h.calls.push('download');
        return new Promise<string>((resolve) => {
          finish = () => resolve(dest);
        });
      },
    });
    await h.updater.runUpdateCheck();
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck({ manual: true });
    await h.updater.runUpdateCheck();
    auto = false;
    finish();
    await vi.waitFor(() =>
      expect(h.calls.filter((call) => call === 'download')).toHaveLength(2),
    );
    log.mockRestore();
  });

  it('downloads no newer release an automatic check found once the switch is off', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let auto = true;
    let latest = update;
    let finish: () => void = () => undefined;
    const h = harness({
      autoUpdate: () => auto,
      checkForUpdate: () => Promise.resolve(latest),
      downloadFile: (_url, dest) => {
        h.calls.push('download');
        return new Promise<string>((resolve) => {
          finish = () => resolve(dest);
        });
      },
    });
    await h.updater.runUpdateCheck();
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    auto = false;
    finish();
    await vi.waitFor(() => expect(h.updater.staged()?.version).toBe('1.3.0'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.filter((call) => call === 'download')).toHaveLength(1);
    log.mockRestore();
  });

  it('starts no new download once the swap has started', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let latest = update;
    const h = harness({ checkForUpdate: () => Promise.resolve(latest) });
    h.confirm.answer = true;
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.calls).toContain('quit:200'));
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).not.toContain(`stage:${path.join(updatesDir, '1.4.0')}`);
    expect(h.dirs.get(updatesDir)).toContain('1.3.0');
    log.mockRestore();
  });

  it('starts no second download while one runs', async () => {
    let latest = update;
    const h = harness({
      checkForUpdate: () => Promise.resolve(latest),
      downloadFile: () => {
        h.calls.push('download');
        return new Promise<string>(() => undefined);
      },
    });
    await h.updater.runUpdateCheck();
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    expect(h.calls.filter((call) => call === 'download')).toHaveLength(1);
  });

  it('asks only about the release it staged, never one found meanwhile', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let latest = update;
    let finish: () => void = () => undefined;
    const messageBox = vi.fn(() => Promise.resolve({ response: 0 }));
    const h = harness({
      messageBox,
      checkForUpdate: () => Promise.resolve(latest),
      downloadFile: (_url, dest) =>
        new Promise<string>((resolve) => {
          finish = () => resolve(dest);
        }),
    });
    await h.updater.runUpdateCheck();
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    finish();
    await vi.waitFor(() => expect(h.updater.staged()?.version).toBe('1.3.0'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.asked).toEqual([]);
    expect(messageBox, 'no assisted download for 1.4.0').not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('keeps the version being downloaded out of a prune', async () => {
    const h = harness({
      downloadFile: () => new Promise<string>(() => undefined),
    });
    await h.updater.runUpdateCheck();
    h.dirs.set(updatesDir, ['1.2.0', '1.3.0', 'file.zip']);
    h.updater.pruneStagedUpdates('1.2.0');
    expect(h.removed).not.toContain(path.join(updatesDir, '1.3.0'));
  });

  it('frees the download slot even when the download cannot be removed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let latest = update;
    const h = harness({
      checkForUpdate: () => Promise.resolve(latest),
      updaterFs: {
        mkdirSync: () => undefined,
        rmSync: (target) => {
          if (target.endsWith('.zip')) throw new Error('EPERM');
        },
        readdirSync: () => [],
        isDirectory: () => true,
        readInstalledPlist: () => null,
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    latest = { ...update, version: '1.4.0' };
    await h.updater.runUpdateCheck();
    await vi.waitFor(() =>
      expect(h.calls).toContain(`stage:${path.join(updatesDir, '1.4.0')}`),
    );
    log.mockRestore();
  });

  it('asks nothing when the install folder can no longer take the copy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const messageBox = vi.fn(() => Promise.resolve({ response: 0 }));
    const h = harness({
      messageBox,
      canInstallInPlace: (installed): installed is string => {
        void installed;
        return false;
      },
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.updater.staged()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.asked).toEqual([]);
    expect(messageBox, 'no unrequested assisted dialog').not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('opens no install prompt, nor a phone install, while a simulated copy unpacks', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let unpack: () => void = () => undefined;
    const h = harness({
      extractUpdate: (input) =>
        new Promise((resolve) => {
          unpack = () =>
            resolve({ version: input.version, appPath: '/staged-sim' });
        }),
    });
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staging = h.updater.stageFromZip('/tmp/DevBar.zip', {
      ...update,
      version: '1.4.0',
    });
    await expect(h.updater.applyUpdate()).resolves.toEqual({
      ok: false,
      busy: true,
    });
    expect(h.updater.canInstallStaged()).toBe(false);
    expect(() => h.updater.setSimulatedUpdate(null)).toThrow(
      /descarga en curso/,
    );
    unpack();
    await staging;
    log.mockRestore();
  });

  it('refuses to simulate again the version already staged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness();
    await h.updater.runUpdateCheck();
    await vi.waitFor(() => expect(h.asked).toEqual(['1.3.0']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      h.updater.stageFromZip('/tmp/DevBar.zip', update),
    ).rejects.toThrow(/ya está preparada/);
    expect(h.calls).not.toContain('extract:/tmp/DevBar.zip');
    log.mockRestore();
  });
});
