import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findRepoRoot,
  main,
  nextMinor,
  REPO_ROOT_MAX_LEVELS,
  USAGE,
  type MainDeps,
  type SimulatedUpdateRequest,
} from '../scripts/build-simulated-update.js';

/**
 * The CI helper that builds the simulated update bundle. Nothing here builds
 * one — `main` takes the builder as a dependency — but everything that
 * decides WHAT it would build is pinned: where the repo root is, which
 * version the update claims, and the argv contract CI depends on.
 */

const roots: string[] = [];

function makeTree(depth: number, markers: 'both' | 'package-only' | 'none') {
  const base = mkdtempSync(path.join(tmpdir(), 'devbar-simupd-'));
  roots.push(base);
  if (markers !== 'none')
    writeFileSync(path.join(base, 'package.json'), '{"version":"1.0.0"}');
  if (markers === 'both')
    writeFileSync(path.join(base, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
  let deepest = base;
  for (let level = 1; level <= depth; level += 1) {
    deepest = path.join(deepest, `L${level}`);
  }
  mkdirSync(deepest, { recursive: true });
  return { base, deepest };
}

interface MainRun {
  code: number;
  requests: SimulatedUpdateRequest[];
  logs: string[];
  errors: string[];
}

async function runMain(options: {
  argv: string[];
  root?: string;
  zip?: string;
}): Promise<MainRun> {
  const requests: SimulatedUpdateRequest[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: MainDeps = {
    argv: options.argv,
    root: options.root ?? path.join(path.sep, 'nonexistent-root'),
    build: (request) => {
      requests.push(request);
      return Promise.resolve(options.zip ?? '/work/sim.zip');
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  };
  return { code: await main(deps), requests, logs, errors };
}

describe('scripts/build-simulated-update.ts', () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  describe('nextMinor', () => {
    it('bumps the minor and resets the patch', () => {
      expect(nextMinor('1.2.3')).toBe('1.3.0');
    });

    it('carries a zero minor', () => {
      expect(nextMinor('0.0.9')).toBe('0.1.0');
    });

    it('falls back to 99.0.0 for a two-part version', () => {
      expect(nextMinor('1.2')).toBe('99.0.0');
    });

    it('falls back to 99.0.0 for a four-part version', () => {
      expect(nextMinor('1.2.3.4')).toBe('99.0.0');
    });

    it('falls back to 99.0.0 for an empty version', () => {
      expect(nextMinor('')).toBe('99.0.0');
    });

    it('falls back to 99.0.0 when the major is not a number', () => {
      expect(nextMinor('x.2.3')).toBe('99.0.0');
    });

    it('falls back to 99.0.0 when the minor is not a number', () => {
      expect(nextMinor('1.x.3')).toBe('99.0.0');
    });

    it('does not inspect the patch it is about to discard', () => {
      // Only major and minor are validated: the patch is replaced by 0
      // whatever it said.
      expect(nextMinor('1.2.rc1')).toBe('1.3.0');
    });
  });

  describe('findRepoRoot', () => {
    it('stops at the directory holding package.json AND pnpm-lock.yaml', () => {
      const { base, deepest } = makeTree(3, 'both');
      expect(findRepoRoot(deepest)).toBe(path.resolve(base));
    });

    it('returns the start directory when it is already the root', () => {
      const { base } = makeTree(0, 'both');
      expect(findRepoRoot(base)).toBe(path.resolve(base));
    });

    it('walks past a directory that only has package.json', () => {
      // Every package directory on the way up has a package.json; the
      // lockfile is what makes the match the repository root.
      const { base, deepest } = makeTree(2, 'both');
      const intermediate = path.join(base, 'L1');
      writeFileSync(
        path.join(intermediate, 'package.json'),
        '{"version":"9.9.9"}',
      );
      expect(findRepoRoot(deepest)).toBe(path.resolve(base));
    });

    it(`still finds a root exactly ${REPO_ROOT_MAX_LEVELS - 1} levels up`, () => {
      const { base, deepest } = makeTree(REPO_ROOT_MAX_LEVELS - 1, 'both');
      expect(findRepoRoot(deepest)).toBe(path.resolve(base));
    });

    it(`gives up beyond ${REPO_ROOT_MAX_LEVELS} levels and never reaches the root`, () => {
      const { base, deepest } = makeTree(REPO_ROOT_MAX_LEVELS + 1, 'both');
      expect(findRepoRoot(deepest)).not.toBe(path.resolve(base));
    });

    it('gives up at the filesystem root when nothing matches', () => {
      // Walking up from / must terminate instead of looping on itself.
      expect(findRepoRoot(path.sep)).toBe(path.resolve(path.sep));
    });
  });

  describe('main — argv contract', () => {
    it('refuses a run with no arguments and builds nothing', async () => {
      const run = await runMain({ argv: ['node', 'script'] });
      expect(run.code).toBe(1);
      expect(run.errors).toEqual([USAGE]);
      expect(run.requests).toEqual([]);
    });

    it('refuses a run with a bundle but no work directory', async () => {
      const run = await runMain({ argv: ['node', 'script', '/tmp/App.app'] });
      expect(run.code).toBe(1);
      expect(run.requests).toEqual([]);
    });

    it('prints the zip path CI reads off the last line', async () => {
      const run = await runMain({
        argv: ['node', 'script', '/tmp/App.app', '/tmp/work', '2.0.0'],
        zip: '/tmp/work/sim-2.0.0.zip',
      });
      expect(run.code).toBe(0);
      expect(run.logs).toEqual(['/tmp/work/sim-2.0.0.zip']);
    });
  });

  describe('main — version resolution', () => {
    it('uses the explicit version without reading package.json', async () => {
      // The root here does not exist: an eager read would throw. CI always
      // passes the version, and that path must not depend on the checkout.
      const run = await runMain({
        argv: ['node', 'script', '/tmp/App.app', '/tmp/work', '4.5.6'],
      });
      expect(run.requests).toEqual([
        {
          bundlePath: '/tmp/App.app',
          workDir: '/tmp/work',
          version: '4.5.6',
        },
      ]);
    });

    it('bumps the minor of package.json when no version is given', async () => {
      const base = mkdtempSync(path.join(tmpdir(), 'devbar-simupd-'));
      roots.push(base);
      writeFileSync(path.join(base, 'package.json'), '{"version":"1.4.2"}');
      const run = await runMain({
        argv: ['node', 'script', '/tmp/App.app', '/tmp/work'],
        root: base,
      });
      expect(run.requests[0]?.version).toBe('1.5.0');
    });

    it('treats a whitespace-only version as absent', async () => {
      const base = mkdtempSync(path.join(tmpdir(), 'devbar-simupd-'));
      roots.push(base);
      writeFileSync(path.join(base, 'package.json'), '{"version":"2.7.0"}');
      const run = await runMain({
        argv: ['node', 'script', '/tmp/App.app', '/tmp/work', '   '],
        root: base,
      });
      expect(run.requests[0]?.version).toBe('2.8.0');
    });

    it('falls back to 99.0.0 when package.json has no version', async () => {
      const base = mkdtempSync(path.join(tmpdir(), 'devbar-simupd-'));
      roots.push(base);
      writeFileSync(path.join(base, 'package.json'), '{"name":"devbar"}');
      const run = await runMain({
        argv: ['node', 'script', '/tmp/App.app', '/tmp/work'],
        root: base,
      });
      expect(run.requests[0]?.version).toBe('99.0.0');
    });
  });
});
