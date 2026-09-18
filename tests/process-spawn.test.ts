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
    // $SHELL must be STUBBED: without it the assertion would read the
    // contributor's own login shell, so it would pass for whatever the
    // host happens to have and prove nothing about userShell().
    vi.stubEnv('SHELL', '/usr/bin/fish');
    const build = await buildFor('linux');
    const spec = build('pnpm start');
    expect(spec.file).toBe('/usr/bin/fish');
    expect(spec.args).toEqual(['-ic', 'pnpm start']);
    expect(spec.description).toBe("/usr/bin/fish -ic 'pnpm start'");
  });

  it('falls back to the documented /bin/bash when SHELL is unset', async () => {
    vi.unstubAllEnvs();
    const previous = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const build = await buildFor('linux');
      const spec = build('pnpm start');
      expect(spec.file).toBe('/bin/bash');
      expect(spec.args).toEqual(['-ic', 'pnpm start']);
    } finally {
      if (previous !== undefined) process.env.SHELL = previous;
    }
  });
});

describe('buildSpawnArgs — Windows', () => {
  // The `/c` payload carries ONE extra quote pair, the pair `cmd /s`
  // strips back off before running the rest verbatim. It is only correct
  // together with windowsVerbatimArguments (asserted below): the two are
  // a single contract, copied from Node's own `shell: true` path.
  it('runs the command through ComSpec with /d /s /c and a quote-wrapped payload', async () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
    const build = await buildFor('win32');
    const spec = build('pnpm start');
    expect(spec.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(spec.args).toEqual(['/d', '/s', '/c', '"pnpm start"']);
    expect(spec.description).toBe(
      'C:\\Windows\\system32\\cmd.exe /d /s /c "pnpm start"',
    );
  });

  it('wraps a payload that already begins and ends with a quote (/s strips exactly one pair)', async () => {
    vi.stubEnv('ComSpec', 'C:\\Windows\\system32\\cmd.exe');
    const build = await buildFor('win32');
    const spec = build('"C:\\Program Files\\node.exe" server.js');
    expect(spec.args[3]).toBe('""C:\\Program Files\\node.exe" server.js"');
  });

  it('falls back to cmd.exe when ComSpec is missing', async () => {
    vi.unstubAllEnvs();
    const previous = process.env.ComSpec;
    delete process.env.ComSpec;
    try {
      const build = await buildFor('win32');
      const spec = build('npm test');
      expect(spec.file).toBe('cmd.exe');
      expect(spec.args).toEqual(['/d', '/s', '/c', '"npm test"']);
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
          // NOT verbatim off-Windows: POSIX passes an argv array, so
          // there is no command line for libuv to re-quote.
          windowsVerbatimArguments: false,
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
          // Without this, libuv rewrites every `"` in the /c payload as
          // `\"`; cmd has no backslash escape, so CommandLineToArgvW
          // would read them as literal quotes and split spaced args.
          windowsVerbatimArguments: true,
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
          windowsVerbatimArguments: true,
        }),
      ),
    );
  });
});
