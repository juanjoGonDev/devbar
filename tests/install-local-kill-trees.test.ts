import { describe, expect, it } from 'vitest';
import {
  posixKillServiceTrees,
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
    posixKillServiceTrees(['/install/path'], { run });
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
    ]);
  });

  it('a service with no children (already dead) is skipped quietly', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': '100',
    });
    posixKillServiceTrees(['/x'], { run });
    expect(calls).toEqual([
      ['pgrep', '-f', '/x'],
      ['pgrep', '-P', '100'],
    ]);
  });

  it('never signals its own pid even if pgrep matches the caller', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.pid}\n`,
    });
    posixKillServiceTrees(['/x'], { run });
    expect(calls).toEqual([['pgrep', '-f', '/x']]);
  });

  it('never signals the parent shell either (the CLI passes patterns on argv, which a wrapping shell command line contains)', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.ppid}\n`,
    });
    posixKillServiceTrees(['/x'], { run });
    expect(calls).toEqual([['pgrep', '-f', '/x']]);
  });

  it('still signals real instances when the caller family also matches', () => {
    const { calls, run } = recordingRun({
      'pgrep -f /x': `${process.ppid}\n999\n`,
      'pgrep -P 999': '998\n',
    });
    posixKillServiceTrees(['/x'], { run });
    expect(calls).toEqual([
      ['pgrep', '-f', '/x'],
      ['pgrep', '-P', '999'],
      ['kill', '-s', 'TERM', '--', '-998'],
      ['kill', '-s', 'TERM', '998'],
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
    posixKillServiceTrees(['/a', '/b'], { run });
    expect(calls).toEqual([
      ['pgrep', '-f', '/a'],
      ['pgrep', '-P', '100'],
      ['kill', '-s', 'TERM', '--', '-110'],
      ['kill', '-s', 'TERM', '110'],
      ['pgrep', '-f', '/b'],
      ['pgrep', '-P', '200'],
      ['kill', '-s', 'TERM', '--', '-210'],
      ['kill', '-s', 'TERM', '210'],
    ]);
  });
});
