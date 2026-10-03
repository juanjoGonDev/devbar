import { describe, expect, it } from 'vitest';
import {
  buildFixtureGroups,
  clampFixtureRepeat,
  type FixtureEnvironment,
} from '../src/dev/fixture-groups.js';
import { ICON_BATTERY } from '../src/icon-battery.js';
import { normalizeGroup } from '../src/groups-model.js';
import type { Group } from '../src/domain-types.js';

function env(overrides: Partial<FixtureEnvironment> = {}): FixtureEnvironment {
  return {
    platform: 'darwin',
    execPath: '/Applications/DevBar.app/Contents/MacOS/DevBar',
    tmpDir: '/tmp',
    repoPath: null,
    ...overrides,
  };
}

function everyRunnable(groups: readonly Group[]) {
  return groups.flatMap((g) => [...g.commands, ...g.actions]);
}

const KNOWN_ICONS = new Set(ICON_BATTERY.map((item) => item.name));

describe('src/dev/fixture-groups.ts', () => {
  describe('buildFixtureGroups', () => {
    it('prefixes every group id so no process can collide with a real one', () => {
      const groups = buildFixtureGroups(env(), 3);
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) expect(group.id).toMatch(/^fixture-/);
    });

    it('gives every copy unique ids and a numbered name', () => {
      const groups = buildFixtureGroups(env(), 3);
      const ids = groups.map((g) => g.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(groups.map((g) => g.name)).toContain('Prueba 3 · Servicios');
      expect(groups.map((g) => g.order)).toEqual(groups.map((_, i) => i));
    });

    it('repeats the whole set N times', () => {
      const one = buildFixtureGroups(env(), 1);
      expect(buildFixtureGroups(env(), 4)).toHaveLength(one.length * 4);
    });

    it('is already in the shape the store normalizes to', () => {
      for (const group of buildFixtureGroups(env(), 1))
        expect(normalizeGroup(group)).toEqual(group);
    });

    it('covers ok, warnings and errors, a failed exit, missing commands and a flood', () => {
      const names = buildFixtureGroups(env(), 1).flatMap((g) =>
        g.commands.map((c) => c.id),
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'tick',
          'alerts',
          'flood',
          'exit-1',
          'missing-command',
          'missing-cwd',
        ]),
      );
    });

    it('offers an action that succeeds, one that fails and a slow one', () => {
      const actions = buildFixtureGroups(env(), 1).flatMap((g) =>
        g.actions.map((a) => a.id),
      );
      expect(actions).toEqual(['ok', 'fail', 'slow']);
    });

    it('runs the long scripts on the app binary as node, so no node install is needed', () => {
      const tick = buildFixtureGroups(env(), 1)
        .flatMap((g) => g.commands)
        .find((c) => c.id === 'tick');
      expect(tick?.command).toContain(
        "/Applications/DevBar.app/Contents/MacOS/DevBar -e '",
      );
      expect(tick?.env).toContainEqual({
        key: 'ELECTRON_RUN_AS_NODE',
        value: '1',
        enabled: true,
      });
    });

    it('uses cmd syntax on Windows and sh syntax elsewhere', () => {
      const exitOn = (platform: NodeJS.Platform) =>
        buildFixtureGroups(env({ platform }), 1)
          .flatMap((g) => g.commands)
          .find((c) => c.id === 'exit-1')?.command;
      expect(exitOn('win32')).toContain('exit /b 1');
      expect(exitOn('darwin')).toContain('exit 1');
      expect(exitOn('darwin')).not.toContain('/b');
      expect(exitOn('linux')).toBe(exitOn('darwin'));
    });

    it('quotes an app path with spaces for cmd on Windows', () => {
      const tick = buildFixtureGroups(
        env({
          platform: 'win32',
          execPath: 'C:\\Users\\Ana López\\DevBar\\DevBar.exe',
          tmpDir: 'C:\\Temp',
        }),
        1,
      )
        .flatMap((g) => g.commands)
        .find((c) => c.id === 'tick');
      expect(
        tick?.command.startsWith(
          '"C:\\Users\\Ana López\\DevBar\\DevBar.exe" -e "',
        ),
      ).toBe(true);
    });

    it('keeps cmd metacharacters out of the node scripts', () => {
      // These are what cmd.exe would reinterpret even with careful quoting.
      for (const item of everyRunnable(buildFixtureGroups(env(), 1)))
        if (item.command.includes(' -e '))
          expect(item.command.split(' -e ')[1]).not.toMatch(/[<>&|%^!"]/);
    });

    it('works from the temp dir, with a git repo only when one is given', () => {
      const plain = buildFixtureGroups(env(), 1).map((g) => g.path);
      expect(new Set(plain)).toEqual(new Set(['/tmp']));
      const withRepo = buildFixtureGroups(env({ repoPath: '/src/devbar' }), 1);
      expect(withRepo.map((g) => g.path)).toContain('/src/devbar');
    });

    it('uses bundled icons in more than one colour', () => {
      const groups = buildFixtureGroups(env(), 1);
      const icons = [
        ...groups.map((g) => g.icon),
        ...everyRunnable(groups).map((item) => item.icon),
      ];
      for (const name of icons) expect(KNOWN_ICONS.has(name ?? '')).toBe(true);
      const colours = new Set(groups.map((g) => g.iconColor));
      expect(colours.size).toBeGreaterThan(1);
      expect(colours.has(null)).toBe(false);
    });
  });

  describe('clampFixtureRepeat', () => {
    it('keeps a value between 1 and 20', () => {
      expect(clampFixtureRepeat(5)).toBe(5);
      expect(clampFixtureRepeat(0)).toBe(1);
      expect(clampFixtureRepeat(99)).toBe(20);
      expect(clampFixtureRepeat(2.7)).toBe(2);
    });

    it('falls back to one copy for anything that is not a number', () => {
      expect(clampFixtureRepeat('3')).toBe(1);
      expect(clampFixtureRepeat(Number.NaN)).toBe(1);
      expect(clampFixtureRepeat(undefined)).toBe(1);
    });
  });
});
