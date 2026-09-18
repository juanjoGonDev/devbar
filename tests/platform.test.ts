import { afterEach, describe, expect, it, vi } from 'vitest';

type PlatformModule = typeof import('../src/platform.js');

/**
 * platform.ts reads `process.platform` at MODULE LOAD (isMac/isWin/isLinux
 * are consts), so every case needs a fresh module graph with the platform
 * already faked — hence resetModules + a dynamic import, the same pattern
 * tests/process-spawn.test.ts uses. The spy and the env stubs are undone
 * by the afterEach below.
 */
async function loadFor(platform: NodeJS.Platform): Promise<PlatformModule> {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  return import('../src/platform.js');
}

/** Run `fn` with a variable deleted from the real environment and restored
 *  afterwards. vi.stubEnv can only SET a value, not unset one. */
async function withoutEnv(name: string, fn: () => Promise<void>) {
  vi.unstubAllEnvs();
  const previous = process.env[name];
  delete process.env[name];
  try {
    await fn();
  } finally {
    if (previous !== undefined) process.env[name] = previous;
  }
}

describe('src/platform.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Vitest 5 does not unstub environments automatically: restoreAllMocks
    // does not undo vi.stubEnv, so a stubbed SHELL would leak into the next
    // test file's expectations of a native process.
    vi.unstubAllEnvs();
  });

  describe('platform flags', () => {
    it('sets exactly one flag per host', async () => {
      const mac = await loadFor('darwin');
      expect([mac.isMac, mac.isWin, mac.isLinux]).toEqual([true, false, false]);
      const win = await loadFor('win32');
      expect([win.isMac, win.isWin, win.isLinux]).toEqual([false, true, false]);
      const linux = await loadFor('linux');
      expect([linux.isMac, linux.isWin, linux.isLinux]).toEqual([
        false,
        false,
        true,
      ]);
    });
  });

  describe('userShell — $SHELL wins on both POSIX platforms', () => {
    it('honors $SHELL on linux', async () => {
      vi.stubEnv('SHELL', '/usr/bin/fish');
      expect((await loadFor('linux')).userShell()).toBe('/usr/bin/fish');
    });

    // The doc comment used to claim macOS pinned zsh regardless; it does not.
    it('honors $SHELL on darwin too (no historical zsh pin)', async () => {
      vi.stubEnv('SHELL', '/usr/bin/fish');
      expect((await loadFor('darwin')).userShell()).toBe('/usr/bin/fish');
    });
  });

  describe('userShell — per-OS fallback when $SHELL is unset', () => {
    it('falls back to /bin/zsh on darwin', async () => {
      await withoutEnv('SHELL', async () => {
        expect((await loadFor('darwin')).userShell()).toBe('/bin/zsh');
      });
    });

    it('falls back to /bin/bash on linux', async () => {
      await withoutEnv('SHELL', async () => {
        expect((await loadFor('linux')).userShell()).toBe('/bin/bash');
      });
    });

    it('treats an EMPTY $SHELL as unset (||, not ??)', async () => {
      vi.stubEnv('SHELL', '');
      expect((await loadFor('linux')).userShell()).toBe('/bin/bash');
      expect((await loadFor('darwin')).userShell()).toBe('/bin/zsh');
    });
  });

  describe('userShell — Windows uses ComSpec, never $SHELL', () => {
    it('returns ComSpec when set', async () => {
      vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
      // A $SHELL inherited from a Git-Bash style terminal must not win.
      vi.stubEnv('SHELL', '/usr/bin/bash');
      expect((await loadFor('win32')).userShell()).toBe(
        'C:\\Windows\\system32\\cmd.exe',
      );
    });

    it('falls back to bare cmd.exe when ComSpec is unset', async () => {
      await withoutEnv('ComSpec', async () => {
        expect((await loadFor('win32')).userShell()).toBe('cmd.exe');
      });
    });

    it('treats an EMPTY ComSpec as unset (an empty file would spawn nothing)', async () => {
      vi.stubEnv('ComSpec', '');
      expect((await loadFor('win32')).userShell()).toBe('cmd.exe');
    });
  });

  describe('platformLabel', () => {
    it('reports win on win32', async () => {
      expect((await loadFor('win32')).platformLabel()).toBe('win');
    });

    it('reports linux on linux', async () => {
      expect((await loadFor('linux')).platformLabel()).toBe('linux');
    });

    it('reports macos on darwin', async () => {
      expect((await loadFor('darwin')).platformLabel()).toBe('macos');
    });

    it('reports macos for any other platform (the trailing branch)', async () => {
      // freebsd hits neither isWin nor isLinux: the label falls through to
      // the macOS default rather than returning something unhandled.
      expect((await loadFor('freebsd')).platformLabel()).toBe('macos');
    });
  });
});
