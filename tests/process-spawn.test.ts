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
  // Vitest 5 does not unstub environments automatically: restoreAllMocks
  // does not undo vi.stubEnv, so a stubbed ComSpec would leak into the
  // next test file's expectations of a native process.
  vi.unstubAllEnvs();
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

/** Run fn with process.stdout.isTTY forced to a deterministic value.
 *  process.stdout cannot be mocked with vi.spyOn, so the descriptor is
 *  swapped and restored explicitly (vi.restoreAllMocks would not). */
async function withStdoutIsTTY(
  isTTY: boolean | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  // stdout is an accessor property; swap it for a plain data descriptor.
  Object.defineProperty(process, 'stdout', {
    value: { isTTY },
    writable: true,
    configurable: true,
  });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'stdout', original);
  }
}

describe('serviceSpawnOptions — POSIX', () => {
  it('detached: the service owns its process group so a stop signals the whole tree', async () => {
    vi.resetModules();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const mod = await import('../src/process-manager.js');
    await withStdoutIsTTY(true, () =>
      Promise.resolve(
        expect(mod.serviceSpawnOptions()).toStrictEqual({
          detached: true,
          windowsHide: false, // from a terminal; ignored on POSIX anyway
        }),
      ),
    );
  });
});

describe('serviceSpawnOptions — Windows', () => {
  it('attached, and NO windowsHide from a terminal: the service shares the console so Ctrl+C / closing the window reaches it too', async () => {
    vi.resetModules();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const mod = await import('../src/process-manager.js');
    await withStdoutIsTTY(true, () =>
      Promise.resolve(
        expect(mod.serviceSpawnOptions()).toStrictEqual({
          detached: false,
          windowsHide: false,
        }),
      ),
    );
  });

  it('windowsHide for a GUI launch: no console to share, and no visible cmd.exe window per service', async () => {
    vi.resetModules();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const mod = await import('../src/process-manager.js');
    await withStdoutIsTTY(false, () =>
      Promise.resolve(
        expect(mod.serviceSpawnOptions()).toStrictEqual({
          detached: false,
          windowsHide: true,
        }),
      ),
    );
  });
});
