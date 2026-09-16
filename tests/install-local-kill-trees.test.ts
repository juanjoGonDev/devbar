import { describe, expect, it } from 'vitest';
import {
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

describe('posixKillServiceTrees', () => {
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
    posixKillServiceTrees(['/install/path'], { run, wait: () => {} });
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
    posixKillServiceTrees(['/x'], { run, wait: () => {} });
    expect(calls).toEqual([
      ['pgrep', '-f', '/x'],
      ['pgrep', '-P', '100'],
    ]);
  });

  it('never signals its own pid even if pgrep matches the caller', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.pid}\n`,
    });
    posixKillServiceTrees(['/x'], { run, wait: () => {} });
    expect(calls).toEqual([['pgrep', '-f', '/x']]);
  });

  it('never signals the parent shell either (the CLI passes patterns on argv, which a wrapping shell command line contains)', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.ppid}\n`,
    });
    posixKillServiceTrees(['/x'], { run, wait: () => {} });
    expect(calls).toEqual([['pgrep', '-f', '/x']]);
  });

  it('still signals real instances when the caller family also matches', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.ppid}\n999\n`,
      'pgrep -P 999': '998\n',
    });
    posixKillServiceTrees(['/x'], { run, wait: () => {} });
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
    posixKillServiceTrees(['/x', '/y'], { run });
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
    posixKillServiceTrees(['/a', '/b'], { run, wait: () => {} });
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
