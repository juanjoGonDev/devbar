import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  logPath,
  tailLogs,
  type TailChild,
  type TailDeps,
  type TailSpawnOptions,
} from '../scripts/logs.js';

/**
 * `pnpm run logs` has to find the same app.log the packaged app writes, on
 * three operating systems, from one machine's point of view. `logPath` takes
 * the platform and the home directory so all three layouts are reachable
 * here, and `tailLogs` takes its effects so the child handlers — the part
 * that decides whether the command reports success — are reachable too.
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: TailSpawnOptions;
}

interface Harness {
  child: TailChild;
  spawns: SpawnCall[];
  info: string[];
  warn: string[];
  exitCodes: number[];
  emitError: (error: Error) => void;
  emitClose: (code: number | null) => void;
  result: TailChild | null;
}

function tail(options: {
  platform?: NodeJS.Platform;
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  exists?: boolean;
}): Harness {
  const spawns: SpawnCall[] = [];
  const info: string[] = [];
  const warn: string[] = [];
  const exitCodes: number[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const closeListeners: ((code: number | null) => void)[] = [];
  const child = {
    on: (event: string, listener: unknown): unknown => {
      if (event === 'error')
        errorListeners.push(listener as (error: Error) => void);
      if (event === 'close')
        closeListeners.push(listener as (code: number | null) => void);
      return undefined;
    },
  } as unknown as TailChild;

  const deps: TailDeps = {
    platform: options.platform ?? 'linux',
    logFile: options.logFile ?? '/var/log/devbar/app.log',
    env: options.env ?? {},
    exists: () => options.exists ?? true,
    spawn: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      return child;
    },
    info: (message) => info.push(message),
    warn: (message) => warn.push(message),
    setExitCode: (code) => exitCodes.push(code),
  };

  const result = tailLogs(deps);
  return {
    child,
    spawns,
    info,
    warn,
    exitCodes,
    result,
    emitError: (error) => {
      for (const listener of errorListeners) listener(error);
    },
    emitClose: (code) => {
      for (const listener of closeListeners) listener(code);
    },
  };
}

describe('scripts/logs.ts', () => {
  describe('logPath', () => {
    const home = path.join(path.sep, 'home', 'u');

    it('uses the macOS Logs folder', () => {
      withEnv({ XDG_CONFIG_HOME: undefined, APPDATA: undefined }, () => {
        expect(logPath('darwin', home)).toBe(
          path.join(home, 'Library', 'Logs', 'DevBar', 'app.log'),
        );
      });
    });

    it('ignores XDG_CONFIG_HOME on macOS', () => {
      // macOS has its own convention; an XDG variable set by a shell profile
      // must not move the file the packaged app writes.
      withEnv({ XDG_CONFIG_HOME: path.join(path.sep, 'xdg') }, () => {
        expect(logPath('darwin', home)).toBe(
          path.join(home, 'Library', 'Logs', 'DevBar', 'app.log'),
        );
      });
    });

    it('honours an absolute APPDATA on Windows', () => {
      withEnv({ APPDATA: path.join(path.sep, 'roaming') }, () => {
        expect(logPath('win32', home)).toBe(
          path.join(path.sep, 'roaming', 'DevBar', 'logs', 'app.log'),
        );
      });
    });

    it('falls back to the profile AppData when APPDATA is unset', () => {
      withEnv({ APPDATA: undefined }, () => {
        expect(logPath('win32', home)).toBe(
          path.join(home, 'AppData', 'Roaming', 'DevBar', 'logs', 'app.log'),
        );
      });
    });

    it('refuses a RELATIVE APPDATA (it would land inside the cwd)', () => {
      withEnv({ APPDATA: path.join('relative', 'roaming') }, () => {
        expect(logPath('win32', home)).toBe(
          path.join(home, 'AppData', 'Roaming', 'DevBar', 'logs', 'app.log'),
        );
      });
    });

    it('honours an absolute XDG_CONFIG_HOME on Linux', () => {
      withEnv({ XDG_CONFIG_HOME: path.join(path.sep, 'xdg') }, () => {
        expect(logPath('linux', home)).toBe(
          path.join(path.sep, 'xdg', 'DevBar', 'logs', 'app.log'),
        );
      });
    });

    it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
      withEnv({ XDG_CONFIG_HOME: undefined }, () => {
        expect(logPath('linux', home)).toBe(
          path.join(home, '.config', 'DevBar', 'logs', 'app.log'),
        );
      });
    });

    it('falls back to ~/.config when XDG_CONFIG_HOME is EMPTY', () => {
      withEnv({ XDG_CONFIG_HOME: '' }, () => {
        expect(logPath('linux', home)).toBe(
          path.join(home, '.config', 'DevBar', 'logs', 'app.log'),
        );
      });
    });
  });

  describe('tailLogs — nothing to tail', () => {
    it('explains where it looked and spawns nothing', () => {
      const harness = tail({ exists: false, logFile: '/tmp/absent.log' });
      expect(harness.result).toBeNull();
      expect(harness.spawns).toEqual([]);
      expect(harness.info).toEqual([
        'Aún no hay logs en /tmp/absent.log (arranca DevBar primero, o define DEVBAR_LOG_PATH).',
      ]);
    });

    it('leaves the exit code alone (no logs yet is not a failure)', () => {
      const harness = tail({ exists: false });
      expect(harness.exitCodes).toEqual([]);
    });
  });

  describe('tailLogs — POSIX', () => {
    it('follows the file with tail -F', () => {
      const harness = tail({ platform: 'linux', logFile: '/logs/app.log' });
      expect(harness.spawns).toEqual([
        {
          command: 'tail',
          args: ['-F', '/logs/app.log'],
          options: { stdio: 'inherit' },
        },
      ]);
    });

    it('announces the file it is following', () => {
      const harness = tail({ platform: 'darwin', logFile: '/logs/app.log' });
      expect(harness.info).toEqual([
        'Tailing /logs/app.log (Ctrl+C para parar):',
      ]);
    });

    it('returns the child so it stays referenced', () => {
      const harness = tail({ platform: 'darwin' });
      expect(harness.result).toBe(harness.child);
    });
  });

  describe('tailLogs — Windows', () => {
    it('passes the path through the environment, never into the command', () => {
      // A profile named o'Brien would otherwise terminate the single-quoted
      // PowerShell string and spawn would fail to even parse the command.
      const logFile = "C:\\Users\\o'Brien\\AppData\\Roaming\\DevBar\\app.log";
      const harness = tail({
        platform: 'win32',
        logFile,
        env: { PATH: '/bin' },
      });
      expect(harness.spawns).toEqual([
        {
          command: 'powershell',
          args: [
            '-NoProfile',
            '-Command',
            'Get-Content -LiteralPath $env:DEVBAR_LOG_PATH -Wait -Tail 100',
          ],
          options: {
            stdio: 'inherit',
            env: { PATH: '/bin', DEVBAR_LOG_PATH: logFile },
          },
        },
      ]);
      expect(harness.spawns[0]?.args.join(' ')).not.toContain(logFile);
    });

    it('keeps the rest of the environment the child needs', () => {
      const harness = tail({
        platform: 'win32',
        logFile: 'C:\\log.txt',
        env: { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' },
      });
      expect(harness.spawns[0]?.options.env).toEqual({
        PATH: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\u',
        DEVBAR_LOG_PATH: 'C:\\log.txt',
      });
    });
  });

  describe('tailLogs — child outcome', () => {
    it('fails when the tail binary cannot even start', () => {
      const harness = tail({});
      harness.emitError(new Error('spawn tail ENOENT'));
      expect(harness.warn).toEqual([
        'No se pudo arrancar el tail de logs: spawn tail ENOENT',
      ]);
      expect(harness.exitCodes).toEqual([1]);
    });

    it('adopts a nonzero child exit code', () => {
      const harness = tail({});
      harness.emitClose(3);
      expect(harness.exitCodes).toEqual([3]);
    });

    it('stays successful when the child exits cleanly', () => {
      const harness = tail({});
      harness.emitClose(0);
      expect(harness.exitCodes).toEqual([]);
    });

    it('stays successful when Ctrl+C kills the child (null code)', () => {
      // A signal exits with a null code. Treating that as a failure would
      // make the documented way out of `pnpm run logs` report an error.
      const harness = tail({});
      harness.emitClose(null);
      expect(harness.exitCodes).toEqual([]);
    });
  });
});
