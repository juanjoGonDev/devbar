import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ereEscape,
  POSIX_POST_KILL_POLL_MS,
  POSIX_POST_KILL_POLLS,
  POSIX_SERVICE_GRACE_MS,
  posixKillServiceTrees,
  psLikeEscape,
  windowsKillDevInstanceCommand,
  windowsKillImageTreeArgs,
  type KillTreeRun,
} from '../scripts/lib/kill-trees.js';

/**
 * install-local kills any running DevBar before replacing the install. The
 * running instance owns service trees (its commands = the user's dev
 * servers, detached into their own process groups), so the kill must be
 * tree-aware on every OS or the reinstall leaves the services holding
 * their ports. These tests pin the exact argument shapes.
 */

describe('windowsKillImageTreeArgs', () => {
  it('walks the whole tree: /T is what reaches the services', () => {
    expect(windowsKillImageTreeArgs('DevBar.exe')).toEqual([
      '/F',
      '/T',
      '/IM',
      'DevBar.exe',
    ]);
  });
});

describe('windowsKillDevInstanceCommand', () => {
  it('matches electron.exe by checkout path and taskkills each tree with /T', () => {
    const cmd = windowsKillDevInstanceCommand('C:\\repo\\devbar');
    expect(cmd).toContain("Name='electron.exe'");
    expect(cmd).toContain(`*C:\\repo\\devbar*`);
    expect(cmd).toMatch(/taskkill \/PID \$\(\$_\.ProcessId\) \/T \/F/);
  });

  it('escapes single quotes so the path cannot break out of the PS string', () => {
    // A path containing ' would otherwise terminate the single-quoted
    // -like pattern early and inject PowerShell.
    const cmd = windowsKillDevInstanceCommand("C:\\repo\\o'brien");
    expect(cmd).toContain(`*C:\\repo\\o''brien*`);
    // No raw unescaped quote from the path may appear.
    expect(cmd).not.toContain("C:\\repo\\o'brien");
  });
});

describe('psLikeEscape', () => {
  it('leaves ordinary backslash paths untouched', () => {
    expect(psLikeEscape('C:\\repo\\devbar')).toBe('C:\\repo\\devbar');
  });
  it('doubles single quotes (PS single-quoted string terminator)', () => {
    expect(psLikeEscape("a'b")).toBe("a''b");
  });
  it('escapes the -like wildcards with the backtick (the documented escape)', () => {
    expect(psLikeEscape('a[b]c*d?e')).toBe('a`[b`]c`*d`?e');
  });
  it("doubles a literal backtick (it is -like's own escape character)", () => {
    expect(psLikeEscape('a`b')).toBe('a``b');
  });
  it('is the identity for paths with no specials', () => {
    expect(psLikeEscape('/plain/path')).toBe('/plain/path');
  });
});

describe('ereEscape', () => {
  it('escapes ERE metacharacters, including both square brackets', () => {
    expect(ereEscape('a[b].c(d){e}+f?g^h$i|j\\k')).toBe(
      'a\\[b\\]\\.c\\(d\\)\\{e\\}\\+f\\?g\\^h\\$i\\|j\\\\k',
    );
  });
});

describe('posixKillServiceTrees', () => {
  /**
   * Every call below MUST inject `groupAlive` AND `processIdentity`.
   * Omitting either falls back to the real defaults, which probe THE HOST
   * process table with the scripted pid (`kill -0 -- -<pid>`, and
   * `ps -o lstart= -p <pid>` wherever /proc is absent). The suite then
   * asserts against whatever that pid happens to be on the machine: a live
   * one adds the whole post-kill poll budget to the recorded waits, and a
   * pid whose liveness flips between discovery and revalidation makes the
   * SIGKILL escalation silently drop. Keep the invariant uniform even on
   * the tests that never reach a probe today — one added `pgrep -P` line
   * in a fixture is all it takes to re-couple them to the host.
   */
  const STABLE_IDENTITY = () => 'starttime:1234';

  function recordingRun(scripted: Record<string, string | null> = {}) {
    const calls: string[][] = [];
    const run: KillTreeRun = (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args.join(' ')}`;
      if (key in scripted) return scripted[key];
      return null;
    };
    return { calls, run };
  }

  it('signals the process group of each service (leader == child pid), in instance order', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /install/path': '100\n200\n',
      'pgrep -P 100': '110\n',
      'pgrep -P 200': '210\n220\n',
    });
    posixKillServiceTrees(['/install/path'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(calls).toEqual([
      ['pgrep', '-f', '/install/path'],
      ['pgrep', '-P', '100'],
      ['kill', '-s', 'TERM', '--', '-110'],
      ['kill', '-s', 'TERM', '110'],
      ['pgrep', '-P', '200'],
      ['kill', '-s', 'TERM', '--', '-210'],
      ['kill', '-s', 'TERM', '210'],
      ['kill', '-s', 'TERM', '--', '-220'],
      ['kill', '-s', 'TERM', '220'],
      // grace wait, then the SIGKILL escalation for every retained group.
      ['kill', '-s', 'KILL', '--', '-110'],
      ['kill', '-s', 'KILL', '110'],
      ['kill', '-s', 'KILL', '--', '-210'],
      ['kill', '-s', 'KILL', '210'],
      ['kill', '-s', 'KILL', '--', '-220'],
      ['kill', '-s', 'KILL', '220'],
    ]);
  });

  it('a service with no children (already dead) is skipped quietly', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': '100',
    });
    posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(calls).toEqual([
      ['pgrep', '-f', '/x'],
      ['pgrep', '-P', '100'],
    ]);
  });

  it('never signals its own pid even if pgrep matches the caller', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.pid}\n`,
    });
    posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(calls).toEqual([['pgrep', '-f', '/x']]);
  });

  it('never signals the parent shell either (the CLI passes patterns on argv, which a wrapping shell command line contains)', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.ppid}\n`,
    });
    posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(calls).toEqual([['pgrep', '-f', '/x']]);
  });

  it('still signals real instances when the caller family also matches', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.ppid}\n999\n`,
      'pgrep -P 999': '998\n',
    });
    posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(calls).toEqual([
      ['pgrep', '-f', '/x'],
      ['pgrep', '-P', '999'],
      ['kill', '-s', 'TERM', '--', '-998'],
      ['kill', '-s', 'TERM', '998'],
      ['kill', '-s', 'KILL', '--', '-998'],
      ['kill', '-s', 'KILL', '998'],
    ]);
  });

  it('a pattern matching nothing is a no-op (clean machine is the normal case)', () => {
    const { calls, run } = recordingRun();
    posixKillServiceTrees(['/x', '/y'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(calls).toEqual([
      ['pgrep', '-f', '/x'],
      ['pgrep', '-f', '/y'],
    ]);
  });

  it('walks every pattern independently', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /a': '100\n',
      'pgrep -P 100': '110\n',
      'pgrep -f /b': '200\n',
      'pgrep -P 200': '210\n',
    });
    posixKillServiceTrees(['/a', '/b'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    // Both patterns are walked first (TERM for each group as it is found),
    // then a single grace wait, then the KILL escalation in discovery order.
    expect(calls).toEqual([
      ['pgrep', '-f', '/a'],
      ['pgrep', '-P', '100'],
      ['kill', '-s', 'TERM', '--', '-110'],
      ['kill', '-s', 'TERM', '110'],
      ['pgrep', '-f', '/b'],
      ['pgrep', '-P', '200'],
      ['kill', '-s', 'TERM', '--', '-210'],
      ['kill', '-s', 'TERM', '210'],
      ['kill', '-s', 'KILL', '--', '-110'],
      ['kill', '-s', 'KILL', '110'],
      ['kill', '-s', 'KILL', '--', '-210'],
      ['kill', '-s', 'KILL', '210'],
    ]);
  });

  it('escalates a TERM-resistant group to SIGKILL after the grace wait', () => {
    // The group survives the TERM signals (the fake run does not model
    // deaths — every KILL issued stands). The escalation must come AFTER
    // the wait, never before.
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const waits: number[] = [];
    posixKillServiceTrees(['/x'], {
      run,
      wait: (ms) => {
        waits.push(ms);
      },
      // The group is TERM-resistant but dies on the KILL: no post-kill
      // polling, so the grace wait is the only wait. Both probes are faked
      // because the real ones would answer for the HOST's pid 110.
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(waits).toEqual([POSIX_SERVICE_GRACE_MS]);
    // The KILLs come strictly after both TERM signals (the wait sits
    // between them in the real flow; here it is injected as a no-op that
    // only records it happened — see `waits` above).
    expect(events).toEqual([
      'pgrep -f /x',
      'pgrep -P 100',
      'kill -s TERM -- -110',
      'kill -s TERM 110',
      'kill -s KILL -- -110',
      'kill -s KILL 110',
    ]);
  });

  it('skips the KILL when the leader pid was REUSED during the grace wait', () => {
    // The original leader exits after discovery and its pid is handed to
    // an unrelated process: the identity captured at discovery no longer
    // matches, so both the group kill and the plain-pid kill must be
    // skipped — and the reuse must not be reported as a survivor.
    let phase = 'discovery';
    const processIdentity = (pid: string): string | null => {
      if (pid !== '110') return null;
      return phase === 'discovery' ? 'starttime:1234' : 'starttime:9999';
    };
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'kill') events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const wait = () => {
      phase = 'kill'; // the leader died and the pid was recycled
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait,
      groupAlive: () => false,
      processIdentity,
    });
    expect(survivors).toEqual([]);
    // TERM went out at discovery (before the grace window) — but the
    // DELAYED KILL was skipped: the reused pid was never signaled.
    expect(events).toEqual(['kill -s TERM -- -110', 'kill -s TERM 110']);
  });

  it('does not report a reused-alive group as a survivor', () => {
    // The leader dies right after TERM and its pid (and even its pgid)
    // is handed to an unrelated group that stays ALIVE: the identity no
    // longer matches, so the KILL is skipped AND the live replacement
    // must not be reported as a surviving service (that would fail a
    // healthy install).
    let phase = 'discovery';
    const processIdentity = (pid: string): string | null => {
      if (pid !== '110') return null;
      return phase === 'discovery' ? 'starttime:1234' : 'starttime:9999';
    };
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'kill') events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const wait = () => {
      phase = 'kill'; // leader exited, pid + pgid reused
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait,
      // The REPLACEMENT group is alive on its own...
      groupAlive: () => true,
      processIdentity,
    });
    // ...but it is not OUR service: no survivor reported, no KILL sent.
    expect(survivors).toEqual([]);
    expect(events).toEqual(['kill -s TERM -- -110', 'kill -s TERM 110']);
  });

  it('keeps the KILL when the identity is unchanged', () => {
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'kill') events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: () => 'starttime:1234',
    });
    expect(survivors).toEqual([]);
    expect(events).toEqual([
      'kill -s TERM -- -110',
      'kill -s TERM 110',
      'kill -s KILL -- -110',
      'kill -s KILL 110',
    ]);
  });

  it('still SIGKILLs the group when the LEADER exited but a member ignored TERM', () => {
    // The leader honored TERM and exited during the grace window; another
    // member of its group did not, and still holds the port. "Leader gone"
    // is NOT "group dead": suppressing the group SIGKILL here — and the
    // liveness check with it — reports success while a descendant keeps
    // its port, and install-local.sh then swaps the bundle under it.
    let leaderGone = false;
    const processIdentity = (pid: string): string | null =>
      pid === '110' && !leaderGone ? 'starttime:1234' : null;
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'kill') events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: () => {
        leaderGone = true; // the leader died during the grace window
      },
      groupAlive: () => true, // ...but the group still has a member
      processIdentity,
    });
    // The group signal still goes out. The plain-pid form does not: that
    // pid now belongs to nobody, and could belong to a stranger at any
    // moment.
    expect(events).toEqual([
      'kill -s TERM -- -110',
      'kill -s TERM 110',
      'kill -s KILL -- -110',
    ]);
    // And the member that outlived SIGKILL must reach the caller.
    expect(survivors).toEqual(['110']);
  });

  it('reports no survivor when the leader exited and its group went with it', () => {
    // Same "leader gone" shape as above, but the group is empty: the
    // escalation is a harmless no-op and nothing is reported — a leader
    // that simply honored TERM must not fail a healthy install.
    let leaderGone = false;
    const processIdentity = (pid: string): string | null =>
      pid === '110' && !leaderGone ? 'starttime:1234' : null;
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'kill') events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: () => {
        leaderGone = true;
      },
      groupAlive: () => false,
      processIdentity,
    });
    expect(survivors).toEqual([]);
    expect(events).toEqual([
      'kill -s TERM -- -110',
      'kill -s TERM 110',
      'kill -s KILL -- -110',
    ]);
  });

  it('reports a group that survives SIGKILL so the installer can fail', () => {
    // SIGKILL cannot be caught; a survivor (uninterruptible I/O) means
    // the installer must abort instead of swapping under a live service.
    const events: string[] = [];
    const run: KillTreeRun = (cmd, args) => {
      events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => true, // the group is still here after the KILL
      // ...and it is still OUR group: a stable identity is what keeps the
      // survivor reportable (a mismatch would filter it out silently).
      processIdentity: STABLE_IDENTITY,
    });
    expect(survivors).toEqual(['110']);
    expect(events).toEqual([
      'pgrep -f /x',
      'pgrep -P 100',
      'kill -s TERM -- -110',
      'kill -s TERM 110',
      'kill -s KILL -- -110',
      'kill -s KILL 110',
    ]);
  });

  it('does not report a group that dies within the post-kill poll window', () => {
    // SIGKILL is async: the group is still visible on the immediate probe
    // after the signal, but the kernel reaps it during the bounded
    // post-kill polling — it must not be reported as a false survivor
    // (that would fail a healthy install).
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const waits: number[] = [];
    let probes = 0;
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: (ms) => {
        waits.push(ms);
      },
      groupAlive: () => {
        probes += 1;
        return probes === 1; // alive on the first probe, reaped by the second
      },
      processIdentity: STABLE_IDENTITY,
    });
    expect(survivors).toEqual([]);
    expect(waits).toEqual([POSIX_SERVICE_GRACE_MS, POSIX_POST_KILL_POLL_MS]);
  });

  it('reports a group still alive after the entire post-kill budget, once the budget is spent', () => {
    // A true survivor (stuck in uninterruptible I/O) stays alive through
    // every poll — it is still reported, and the polling is bounded
    // (grace wait + exactly POSIX_POST_KILL_POLLS poll waits).
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const waits: number[] = [];
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: (ms) => {
        waits.push(ms);
      },
      groupAlive: () => true,
      processIdentity: STABLE_IDENTITY,
    });
    expect(survivors).toEqual(['110']);
    expect(waits).toEqual([
      POSIX_SERVICE_GRACE_MS,
      ...Array.from(
        { length: POSIX_POST_KILL_POLLS },
        () => POSIX_POST_KILL_POLL_MS,
      ),
    ]);
  });

  it('reports nothing when every group died on the signals', () => {
    const run: KillTreeRun = (cmd, args) => {
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n';
      if (cmd === 'pgrep') return '110\n';
      return null;
    };
    const survivors = posixKillServiceTrees(['/x'], {
      run,
      wait: () => {},
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(survivors).toEqual([]);
  });

  it('waits and kills at most once even with many groups in one pattern', () => {
    const events: string[] = [];
    let waited = 0;
    const run: KillTreeRun = (cmd, args) => {
      events.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'pgrep' && args[0] === '-f') return '100\n200\n';
      if (cmd === 'pgrep') return args[1] === '100' ? '110\n' : '210\n';
      return null;
    };
    posixKillServiceTrees(['/x'], {
      run,
      wait: () => {
        waited += 1;
      },
      // Both groups die on the KILL: the grace wait is the only wait. Faked
      // because the real probes would answer for the HOST's pids 110/210.
      groupAlive: () => false,
      processIdentity: STABLE_IDENTITY,
    });
    expect(waited).toBe(1);
    expect(events.filter((e) => e.startsWith('kill -s KILL'))).toEqual([
      'kill -s KILL -- -110',
      'kill -s KILL 110',
      'kill -s KILL -- -210',
      'kill -s KILL 210',
    ]);
  });
});

/**
 * The CLI form (`node --experimental-strip-types scripts/lib/kill-trees.ts
 * <pattern>…`) is what install-local.sh calls on macOS, so its exit code IS
 * the installer's go/no-go. Exercised in a subprocess because the entrypoint
 * guard only fires when the module is the one Node was started with.
 *
 * Determinism and safety both come from the fake pgrep/kill/ps placed first
 * on PATH: nothing real is ever discovered, and every pid the run signals is
 * an answer invented by the fake pgrep. If the PATH override ever failed,
 * the real pgrep would match nothing and the test would fail — it could not
 * silently start signaling host processes.
 */
describe('kill-trees CLI entry', () => {
  const CLI = fileURLToPath(
    new URL('../scripts/lib/kill-trees.ts', import.meta.url),
  );
  // A fabricated instance pid and the service-group leader below it.
  const INSTANCE = '424242';
  const LEADER = '424243';
  const STABLE_PS = 'echo "Mon Jan  1 00:00:00 2024"';

  function runCli(fakes: Record<string, string>, pattern: string) {
    const bin = mkdtempSync(join(tmpdir(), 'devbar-kill-trees-'));
    try {
      for (const [name, body] of Object.entries(fakes)) {
        const file = join(bin, name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
      }
      return spawnSync(
        process.execPath,
        ['--experimental-strip-types', CLI, pattern],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        },
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === 'win32')(
    'aborts with exit 1 and names the group that survived SIGKILL',
    () => {
      const res = runCli(
        {
          pgrep: `case "$1" in -f) echo ${INSTANCE};; -P) [ "$2" = ${INSTANCE} ] && echo ${LEADER};; esac; exit 0`,
          // `kill -0 -- -<leader>` keeps succeeding: the group outlives the
          // SIGKILL and the whole post-kill poll budget.
          kill: 'exit 0',
          ps: STABLE_PS,
        },
        '/devbar/fixture/instance',
      );
      // A live service still holding its port must stop the install, not be
      // installed over.
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('survived SIGKILL');
      expect(res.stderr).toContain(LEADER);
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'exits 0 on a clean machine (a pattern matching nothing is the normal case)',
    () => {
      const res = runCli(
        { pgrep: 'exit 1', kill: 'exit 0', ps: STABLE_PS },
        '/devbar/fixture/absent',
      );
      expect(res.status).toBe(0);
      // stderr is not empty — Node prints its type-stripping
      // ExperimentalWarning there — but it must carry no abort.
      expect(res.stderr).not.toContain('survived SIGKILL');
    },
    20_000,
  );
});
