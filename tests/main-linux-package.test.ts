import { describe, expect, it } from 'vitest';
import {
  detectLinuxInstallShape,
  installDebPackage,
  manualDebCommand,
  runProcess,
  type ProcessResult,
  type RunProcess,
} from '../src/main/linux-package.js';

const ok: ProcessResult = { code: 0, stdout: '', stderr: '', spawnError: null };

function recordingRun(results: ProcessResult[]): {
  run: RunProcess;
  calls: { file: string; args: readonly string[] }[];
} {
  const calls: { file: string; args: readonly string[] }[] = [];
  let index = 0;
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args });
      return Promise.resolve(results[index++] ?? ok);
    },
  };
}

const allTools = (target: string): boolean =>
  ['/usr/bin/pkexec', '/usr/bin/apt-get', '/usr/bin/dpkg'].includes(target);

describe('src/main/linux-package.ts', () => {
  describe('detectLinuxInstallShape', () => {
    it('is an AppImage when the running image resolved', async () => {
      const { run, calls } = recordingRun([]);
      await expect(
        detectLinuxInstallShape({
          appImage: '/home/pi/Apps/DevBar.AppImage',
          execPath: '/tmp/.mount_DevBarX/devbar',
          run,
        }),
      ).resolves.toBe('appImage');
      expect(calls).toEqual([]);
    });

    it('is a .deb install when dpkg owns the running executable', async () => {
      const { run, calls } = recordingRun([
        { ...ok, stdout: 'devbar: /opt/DevBar/devbar\n' },
      ]);
      await expect(
        detectLinuxInstallShape({
          appImage: null,
          execPath: '/opt/DevBar/devbar',
          run,
        }),
      ).resolves.toBe('deb');
      expect(calls).toEqual([
        { file: 'dpkg-query', args: ['-S', '/opt/DevBar/devbar'] },
      ]);
    });

    it('accepts a multi-arch package name', async () => {
      const { run } = recordingRun([
        { ...ok, stdout: 'devbar:arm64: /opt/DevBar/devbar\n' },
      ]);
      await expect(
        detectLinuxInstallShape({ appImage: null, execPath: '/x', run }),
      ).resolves.toBe('deb');
    });

    it('is neither when another package owns the file', async () => {
      const { run } = recordingRun([
        { ...ok, stdout: 'electron: /usr/lib/electron/electron\n' },
      ]);
      await expect(
        detectLinuxInstallShape({ appImage: null, execPath: '/x', run }),
      ).resolves.toBe('other');
    });

    it('is neither when dpkg is missing or knows nothing of the file', async () => {
      const missing = recordingRun([
        { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' },
      ]);
      await expect(
        detectLinuxInstallShape({
          appImage: null,
          execPath: '/x',
          run: missing.run,
        }),
      ).resolves.toBe('other');
      const unknown = recordingRun([{ ...ok, code: 1 }]);
      await expect(
        detectLinuxInstallShape({
          appImage: null,
          execPath: '/x',
          run: unknown.run,
        }),
      ).resolves.toBe('other');
    });
  });

  describe('manualDebCommand', () => {
    it('gives a command that works from any directory', () => {
      expect(
        manualDebCommand('/home/pi/Downloads/DevBar-0.9.8-linux-arm64.deb'),
      ).toBe(
        'sudo apt install /home/pi/Downloads/DevBar-0.9.8-linux-arm64.deb',
      );
    });

    it('quotes a path the shell would split', () => {
      expect(manualDebCommand("/home/o'neil/Mis descargas/a.deb")).toBe(
        `sudo apt install '/home/o'\\''neil/Mis descargas/a.deb'`,
      );
    });
  });

  describe('installDebPackage', () => {
    it('installs through pkexec + apt-get with the path as its own argument', async () => {
      const { run, calls } = recordingRun([ok]);
      await expect(
        installDebPackage('/home/pi/Downloads/a b.deb', {
          run,
          exists: allTools,
        }),
      ).resolves.toEqual({ ok: true });
      expect(calls).toEqual([
        {
          file: '/usr/bin/pkexec',
          args: [
            '/usr/bin/apt-get',
            'install',
            '-y',
            '/home/pi/Downloads/a b.deb',
          ],
        },
      ]);
    });

    it('falls back to dpkg -i when apt-get is not installed', async () => {
      const { run, calls } = recordingRun([ok]);
      await installDebPackage('/tmp/a.deb', {
        run,
        exists: (target) => target !== '/usr/bin/apt-get' && allTools(target),
      });
      expect(calls[0]).toEqual({
        file: '/usr/bin/pkexec',
        args: ['/usr/bin/dpkg', '-i', '/tmp/a.deb'],
      });
    });

    it('fails without running anything when pkexec is missing', async () => {
      const { run, calls } = recordingRun([]);
      const result = await installDebPackage('/tmp/a.deb', {
        run,
        exists: (target) => target !== '/usr/bin/pkexec' && allTools(target),
      });
      expect(result).toEqual({
        ok: false,
        reason: 'pkexec no está instalado',
      });
      expect(calls).toEqual([]);
    });

    it('fails when there is no package tool at all', async () => {
      const { run } = recordingRun([]);
      await expect(
        installDebPackage('/tmp/a.deb', {
          run,
          exists: (target) => target === '/usr/bin/pkexec',
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'no se encontró apt-get ni dpkg',
      });
    });

    it('reports a cancelled authentication', async () => {
      const { run } = recordingRun([{ ...ok, code: 126 }]);
      await expect(
        installDebPackage('/tmp/a.deb', { run, exists: allTools }),
      ).resolves.toEqual({ ok: false, reason: 'autenticación cancelada' });
    });

    it('reports an authentication that could not happen', async () => {
      const { run } = recordingRun([{ ...ok, code: 127 }]);
      const result = await installDebPackage('/tmp/a.deb', {
        run,
        exists: allTools,
      });
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.reason).toMatch(/no se pudo autenticar/);
    });

    it('reports the installer failure with its last stderr line', async () => {
      const { run } = recordingRun([
        {
          code: 100,
          stdout: '',
          stderr: 'Reading package lists...\nE: Could not get lock\n',
          spawnError: null,
        },
      ]);
      await expect(
        installDebPackage('/tmp/a.deb', { run, exists: allTools }),
      ).resolves.toEqual({
        ok: false,
        reason: 'apt-get terminó con código 100: E: Could not get lock',
      });
    });

    it('reports a pkexec that could not be started', async () => {
      const { run } = recordingRun([
        { code: null, stdout: '', stderr: '', spawnError: 'EACCES' },
      ]);
      await expect(
        installDebPackage('/tmp/a.deb', { run, exists: allTools }),
      ).resolves.toEqual({
        ok: false,
        reason: 'no se pudo ejecutar pkexec: EACCES',
      });
    });
  });

  describe('runProcess', () => {
    it('captures the exit code and both streams without a shell', async () => {
      const result = await runProcess(process.execPath, [
        '-e',
        'process.stdout.write("out");process.stderr.write("err");process.exit(3)',
      ]);
      expect(result).toEqual({
        code: 3,
        stdout: 'out',
        stderr: 'err',
        spawnError: null,
      });
    });

    it('resolves a successful run with code 0', async () => {
      await expect(
        runProcess(process.execPath, ['-e', '']),
      ).resolves.toMatchObject({ code: 0, spawnError: null });
    });

    it('reports a binary that does not exist instead of throwing', async () => {
      const result = await runProcess('/nonexistent/devbar-tool', []);
      expect(result.code).toBeNull();
      expect(result.spawnError).toMatch(/ENOENT/);
    });
  });
});
