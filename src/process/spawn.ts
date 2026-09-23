/**
 * How a service child process is launched and killed, per platform. Kept
 * apart from `ProcessManager` itself so every platform decision here is a
 * plain function a test can call on any runner (see
 * `tests/process-spawn.test.ts`, which re-imports it with a faked
 * `process.platform`).
 */
import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { isWin, userShell } from '../platform.js';
import { enhancedEnv } from '../path-helper.js';
import { materializeEnv } from '../groups-model.js';
import type { ResolvedTarget } from './state.js';

/**
 * The interpreter that runs a user command, per platform.
 *
 * POSIX uses the user's login shell in interactive-login mode (`-ic`) so the
 * same PATH / aliases / rc files their terminal sees apply. Windows has no
 * comparable login shell, so commands run through `cmd.exe /d /s /c`; the
 * environment has already been enriched by `enhancedEnv`.
 */
function spawnShellForPlatform(): {
  file: string;
  baseArgs: readonly string[];
} {
  if (isWin)
    return {
      file: process.env.ComSpec || 'cmd.exe',
      baseArgs: ['/d', '/s', '/c'],
    };
  return { file: userShell(), baseArgs: ['-ic'] };
}

/**
 * Compose the full argv for running `cmdline` under the platform shell.
 *
 * Windows: the `/c` payload is wrapped in one extra quote pair, exactly as
 * Node's own `shell: true` path does (`['/d','/s','/c','"'+command+'"']`).
 * `/s` makes cmd strip precisely that first/last quote pair and take the
 * rest VERBATIM, which is what lets a payload that itself begins and ends
 * with a quote (`"C:\Program Files\x.exe" arg`) survive intact. The wrap
 * only works together with `windowsVerbatimArguments` (see
 * serviceSpawnOptions): without it libuv would re-escape every inner `"`
 * as `\"` and cmd, which has no backslash escape, would hand those
 * backslashes straight to the child's CommandLineToArgvW as literal
 * quotes.
 */
export function buildSpawnArgs(cmdline: string): {
  file: string;
  args: string[];
  description: string;
} {
  const { file, baseArgs } = spawnShellForPlatform();
  const description = isWin
    ? `${file} /d /s /c "${cmdline}"`
    : `${file} -ic '${cmdline}'`;
  return {
    file,
    args: [...baseArgs, isWin ? `"${cmdline}"` : cmdline],
    description,
  };
}

/**
 * Per-platform spawn options for a service child process.
 *
 * POSIX: `detached` puts the service in its own process group (group
 * leader == the child's pid) so a stop can signal the whole tree — shell +
 * user command + whatever it spawned — with a single `kill(-pgid)`.
 *
 * Windows: stay attached. `windowsHide` is a CAPABILITY, not a constant:
 * - from a terminal (`pnpm start`) — no windowsHide: the service
 *   inherits that console, so Ctrl+C or closing the terminal window
 *   reaches the user's command directly. Forcing windowsHide here would
 *   leave every service alive (holding its port) after the app dies.
 * - from the packaged GUI — windowsHide: there is no console to show,
 *   and without it each spawned cmd.exe can flash a visible terminal
 *   window next to the taskbar.
 *
 * `windowsVerbatimArguments` is MANDATORY on win32 and is what makes the
 * quoting in parse-command.ts correct. Windows has no argv array: libuv
 * builds one command line string, and without this flag it runs
 * `quote_cmd_arg` over each argument — wrapping the `/c` payload and
 * backslash-escaping every `"` inside it as `\"`. `cmd.exe` has no
 * backslash escape, so those backslashes reach the child untouched and
 * `CommandLineToArgvW` reads `\"` as a LITERAL quote instead of the span
 * toggle the escaper emitted: `--title "My App"` would arrive as three
 * arguments (`--title`, `"My`, `App"`). Setting it hands libuv the line
 * verbatim, leaving cmd + CommandLineToArgvW as the only two parsers —
 * which is exactly the pair quoteWindowsArg is written against. Node's own
 * `shell: true` path sets the same flag for the same reason. Ignored on
 * POSIX, where the argv array is passed through as-is.
 */
export function serviceSpawnOptions(): {
  detached: boolean;
  windowsHide: boolean;
  windowsVerbatimArguments: boolean;
} {
  return {
    detached: !isWin,
    windowsHide: !process.stdout.isTTY,
    windowsVerbatimArguments: isWin,
  };
}

/**
 * The environment a service child receives.
 *
 * Only the CONFIGURED overrides go in: `enhancedEnv` spreads `process.env`
 * itself and then replaces PATH with the login shell's one. Re-spreading
 * `process.env` here put the inherited PATH back on top of that, so a
 * GUI-launched app (Finder, login item, autostart) handed its reduced PATH to
 * every service — the exact failure path-helper exists to prevent, invisible
 * under `pnpm start` from a terminal.
 *
 * A command always inherits its group's env; an action or pre-script only
 * does so when it opted in.
 */
export function resolveSpawnEnv(resolved: ResolvedTarget): NodeJS.ProcessEnv {
  if (resolved.kind === 'command')
    return enhancedEnv({
      ...materializeEnv(resolved.group.env),
      ...materializeEnv(resolved.target.env),
    });
  const groupEnv = resolved.target.inheritGroupEnv
    ? materializeEnv(resolved.group.env)
    : {};
  return enhancedEnv({ ...groupEnv, ...materializeEnv(resolved.target.env) });
}

/**
 * Signal the child's whole tree. Returns the error that made the attempt
 * impossible, or null when the kill was dispatched (which on Windows means
 * "taskkill was launched", not "the tree is gone" — it is asynchronous, and
 * its failure is logged from the callback).
 */
export function killGroup(
  child: ChildProcessWithoutNullStreams | null,
  signal: NodeJS.Signals,
): Error | null {
  if (!child?.pid) return null;
  if (isWin) {
    // No process groups on Windows: taskkill /T walks the whole tree
    // (cmd.exe + whatever the user command spawned). /F because there is no
    // portable graceful equivalent that reaches grandchildren.
    try {
      // Log the async failure: a swallowed taskkill error is the only
      // way stop() can reach its 6.5 s give-up, and without this line
      // the give-up would be unexplainable in the app log.
      execFile(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        (error) => {
          if (error) {
            console.error(
              `taskkill failed for pid ${child?.pid}: ${error.message}`,
            );
          }
        },
      );
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  try {
    process.kill(-child.pid, signal);
    return null;
  } catch {
    try {
      child.kill(signal);
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}
