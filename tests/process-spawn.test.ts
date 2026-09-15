import { afterEach, describe, expect, it, vi } from 'vitest';

type SpawnArgs = (cmdline: string) => {
  file: string;
  args: string[];
  description: string;
};

/**
 * Re-import the spawn spec with a faked `process.platform`, so the Windows
 * branch can be exercised on any CI runner. platform.ts reads process.platform
 * at module load, hence resetModules + dynamic import. The platform spy is
 * restored by the global afterEach.
 */
async function buildFor(
  platform: 'win32' | 'linux' | 'darwin',
): Promise<SpawnArgs> {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const mod = await import('../src/process-manager.js');
  return mod.buildSpawnArgs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSpawnArgs — POSIX', () => {
  it('runs the command through the user shell with -ic (profiles apply)', async () => {
    const build = await buildFor('linux');
    const spec = build('pnpm start');
    expect(spec.file).toMatch(/(bash|zsh|fish|sh)$/);
    expect(spec.args).toEqual(['-ic', 'pnpm start']);
    expect(spec.description).toBe(`${spec.file} -ic 'pnpm start'`);
  });
});

describe('buildSpawnArgs — Windows', () => {
  it('runs the command through ComSpec with /d /s /c', async () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
    const build = await buildFor('win32');
    const spec = build('pnpm start');
    expect(spec.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(spec.args).toEqual(['/d', '/s', '/c', 'pnpm start']);
    expect(spec.description).toBe(
      'C:\\Windows\\system32\\cmd.exe /d /s /c "pnpm start"',
    );
  });

  it('falls back to cmd.exe when ComSpec is missing', async () => {
    vi.unstubAllEnvs();
    const previous = process.env.ComSpec;
    delete process.env.ComSpec;
    try {
      const build = await buildFor('win32');
      const spec = build('npm test');
      expect(spec.file).toBe('cmd.exe');
      expect(spec.args).toEqual(['/d', '/s', '/c', 'npm test']);
    } finally {
      if (previous !== undefined) process.env.ComSpec = previous;
    }
  });
});

describe('serviceSpawnOptions — POSIX', () => {
  it('detached: the service owns its process group so a stop signals the whole tree', async () => {
    vi.resetModules();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const mod = await import('../src/process-manager.js');
    expect(mod.serviceSpawnOptions()).toStrictEqual({ detached: true });
  });
});

describe('serviceSpawnOptions — Windows', () => {
  it('attached, and NO windowsHide: a terminal-launched DevBar shares its console so Ctrl+C / closing the window reaches the service too', async () => {
    vi.resetModules();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const mod = await import('../src/process-manager.js');
    expect(mod.serviceSpawnOptions()).toStrictEqual({ detached: false });
  });
});
