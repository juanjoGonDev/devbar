import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLinuxUpdateFlow,
  type LinuxUpdateDeps,
} from '../src/main/linux-update.js';
import { createPhaseStore } from '../src/main/update-phase.js';
import type { AvailableUpdate } from '../src/domain-types.js';
import type { ProcessResult } from '../src/main/linux-package.js';
import type { UpdatePhase } from '../src/ipc-contract.js';

const update: AvailableUpdate = {
  version: '1.3.0',
  url: 'https://github.test/releases/v1.3.0',
  dmgUrl: null,
  zipUrl: null,
  setupUrl: null,
  appImageUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.AppImage',
  debUrl: 'https://github.test/DevBar-1.3.0-linux-arm64.deb',
};

const DEB = '/home/pi/Downloads/DevBar-1.3.0-linux-arm64.deb';
const APPIMAGE = '/home/pi/Downloads/DevBar-1.3.0-linux-arm64.AppImage';

function harness(overrides: Partial<LinuxUpdateDeps> = {}) {
  const calls: string[] = [];
  const phases: UpdatePhase[] = [];
  const processes: { file: string; args: readonly string[] }[] = [];
  let processResult: ProcessResult = {
    code: 0,
    stdout: '',
    stderr: '',
    spawnError: null,
  };
  const deps: LinuxUpdateDeps = {
    repo: { owner: 'o', repo: 'r' },
    arch: 'arm64',
    downloadsDir: () => '/home/pi/Downloads',
    downloadFile: (_url, dest, options) => {
      calls.push(`download:${dest}`);
      options?.onProgress?.({ received: 5, total: 10 });
      return Promise.resolve(dest);
    },
    fetchReleaseSha256: () =>
      Promise.resolve(
        new Map([
          ['DevBar-1.3.0-linux-arm64.deb', 'debhash'],
          ['DevBar-1.3.0-linux-arm64.AppImage', 'aihash'],
        ]),
      ),
    verifySha256: (file, expected) => {
      calls.push(`verify:${file}:${expected ?? ''}`);
      return Promise.resolve(true);
    },
    removeFile: (target) => calls.push(`remove:${target}`),
    linuxInstallShape: () => Promise.resolve('deb'),
    makeExecutable: (target) => calls.push(`chmod:${target}`),
    runProcess: (file, args) => {
      processes.push({ file, args });
      return Promise.resolve(processResult);
    },
    pathExists: (target) =>
      ['/usr/bin/pkexec', '/usr/bin/apt-get'].includes(target),
    openExternal: (url) => calls.push(`external:${url}`),
    markUpdateExit: () => calls.push('markUpdateExit'),
    relaunch: () => calls.push('relaunch'),
    quitAfter: (ms) => calls.push(`quit:${ms}`),
    ...overrides,
  };
  const phase = createPhaseStore((next) => phases.push(next));
  return {
    flow: createLinuxUpdateFlow(deps, phase),
    phase,
    calls,
    phases,
    processes,
    setProcessResult: (next: ProcessResult) => {
      processResult = next;
    },
  };
}

describe('src/main/linux-update.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('download', () => {
    it('downloads the .deb with progress, verifies it and offers the install', async () => {
      const h = harness();
      await expect(h.flow.download(update)).resolves.toEqual({
        ok: true,
        path: DEB,
      });
      expect(h.phases.map((p) => p.state)).toEqual([
        'downloading',
        'downloading',
        'verifying',
        'ready-to-install',
      ]);
      expect(h.phases[1]).toMatchObject({ received: 5, total: 10 });
      expect(h.phase.get()).toEqual({
        state: 'ready-to-install',
        version: '1.3.0',
        path: DEB,
        install: 'package',
        command: `sudo apt install ${DEB}`,
      });
      expect(h.flow.hasPackage('1.3.0')).toBe(true);
    });

    it('only hands out instructions when this copy is not a .deb install', async () => {
      const h = harness({ linuxInstallShape: () => Promise.resolve('other') });
      await h.flow.download(update);
      expect(h.phase.get()).toMatchObject({
        state: 'ready-to-install',
        install: 'manual',
        command: `sudo apt install ${DEB}`,
      });
      expect(h.flow.hasPackage('1.3.0')).toBe(false);
    });

    it('gives an AppImage install the AppImage, executable, with instructions', async () => {
      const h = harness({
        linuxInstallShape: () => Promise.resolve('appImage'),
      });
      await expect(h.flow.download(update)).resolves.toEqual({
        ok: true,
        path: APPIMAGE,
      });
      expect(h.calls).toContain(`download:${APPIMAGE}`);
      expect(h.calls).not.toContain(`download:${DEB}`);
      expect(h.calls).toContain(`chmod:${APPIMAGE}`);
      expect(h.phase.get()).toEqual({
        state: 'ready-to-install',
        version: '1.3.0',
        path: APPIMAGE,
        install: 'manual',
        command: null,
      });
    });

    it('still offers the AppImage when it cannot be marked executable', async () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const h = harness({
        linuxInstallShape: () => Promise.resolve('appImage'),
        makeExecutable: () => {
          throw new Error('EPERM');
        },
      });
      await h.flow.download(update);
      expect(h.phase.get()).toMatchObject({ state: 'ready-to-install' });
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[updates\].*EPERM/);
    });

    it('opens the release page when the release has nothing for Linux', async () => {
      const h = harness();
      await expect(
        h.flow.download({ ...update, debUrl: null, appImageUrl: null }),
      ).resolves.toEqual({ ok: true, opened: 'page' });
      expect(h.calls).toEqual([`external:${update.url}`]);
    });

    it('reports a failed download with its reason and removes the partial file', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = harness({
        downloadFile: () => Promise.reject(new Error('ECONNRESET')),
      });
      await expect(h.flow.download(update)).resolves.toEqual({
        ok: false,
        error: 'ECONNRESET',
      });
      expect(h.phase.get()).toEqual({
        state: 'download-failed',
        version: '1.3.0',
        reason: 'ECONNRESET',
      });
      expect(h.calls).toContain(`remove:${DEB}`);
    });

    it('reports a missing integrity manifest', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = harness({ fetchReleaseSha256: () => Promise.resolve(null) });
      await h.flow.download(update);
      expect(h.phase.get()).toMatchObject({
        state: 'verify-failed',
        reason: 'no se pudo obtener SHA256SUMS.txt',
      });
      expect(h.calls).toContain(`remove:${DEB}`);
    });

    it('never offers a download whose digest does not match', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = harness({ verifySha256: () => Promise.resolve(false) });
      await h.flow.download(update);
      expect(h.phase.get()).toMatchObject({ state: 'verify-failed' });
      expect(h.flow.hasPackage('1.3.0')).toBe(false);
    });
  });

  describe('install', () => {
    it('re-verifies, installs through pkexec and relaunches', async () => {
      const h = harness();
      await h.flow.download(update);
      await expect(h.flow.install('1.3.0')).resolves.toEqual({
        ok: true,
        quitting: true,
        inPlace: true,
      });
      expect(h.calls).toContain(`verify:${DEB}:debhash`);
      expect(h.processes).toEqual([
        {
          file: '/usr/bin/pkexec',
          args: ['/usr/bin/apt-get', 'install', '-y', DEB],
        },
      ]);
      expect(h.phase.get()).toEqual({ state: 'restarting', version: '1.3.0' });
      expect(h.calls.slice(-3)).toEqual([
        'markUpdateExit',
        'relaunch',
        'quit:200',
      ]);
    });

    it('keeps the file and hands out the command when the user cancels', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = harness();
      await h.flow.download(update);
      h.setProcessResult({
        code: 126,
        stdout: '',
        stderr: '',
        spawnError: null,
      });
      await expect(h.flow.install('1.3.0')).resolves.toEqual({
        ok: false,
        error: 'autenticación cancelada',
      });
      expect(h.phase.get()).toEqual({
        state: 'install-failed',
        version: '1.3.0',
        reason: 'autenticación cancelada',
        path: DEB,
        command: `sudo apt install ${DEB}`,
      });
      expect(h.calls).not.toContain(`remove:${DEB}`);
      expect(h.calls).not.toContain('relaunch');
      // Retry is possible: the package is still pending.
      expect(h.flow.hasPackage('1.3.0')).toBe(true);
    });

    it('reports a missing pkexec as an install failure with instructions', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const h = harness({ pathExists: () => false });
      await h.flow.download(update);
      await h.flow.install('1.3.0');
      expect(h.phase.get()).toMatchObject({
        state: 'install-failed',
        reason: 'pkexec no está instalado',
        command: `sudo apt install ${DEB}`,
      });
      expect(h.processes).toEqual([]);
    });

    it('asks for a new download when the file changed since it was verified', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let verified = 0;
      const h = harness({
        verifySha256: () => Promise.resolve(verified++ === 0),
      });
      await h.flow.download(update);
      await h.flow.install('1.3.0');
      expect(h.phase.get()).toMatchObject({ state: 'verify-failed' });
      expect(h.processes).toEqual([]);
      expect(h.flow.hasPackage('1.3.0')).toBe(false);
    });

    it('treats an unreadable file like a changed one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let verified = 0;
      const h = harness({
        verifySha256: () =>
          verified++ === 0
            ? Promise.resolve(true)
            : Promise.reject(new Error('ENOENT')),
      });
      await h.flow.download(update);
      await h.flow.install('1.3.0');
      expect(h.phase.get()).toMatchObject({ state: 'verify-failed' });
    });

    it('refuses without a verified package for that version', async () => {
      const h = harness();
      await expect(h.flow.install('1.3.0')).resolves.toEqual({
        ok: false,
        error: 'no_package',
      });
    });
  });
});
