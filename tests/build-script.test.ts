import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, defaultBuildDeps } from '../scripts/build.js';

/**
 * `pnpm build` is what CI and the installer run, and it starts by DELETING
 * build/. The two expensive steps (tsc, esbuild) are injected, so the
 * choreography around them — what is wiped, in which order the two projects
 * compile, and which renderer files end up shipped — runs here against a
 * throwaway root instead of the checkout.
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devbar-build-'));
  roots.push(root);
  // A previous build that must not survive.
  mkdirSync(join(root, 'build', 'nested'), { recursive: true });
  writeFileSync(join(root, 'build', 'stale.txt'), 'stale');
  writeFileSync(join(root, 'build', 'nested', 'old.js'), 'old');

  mkdirSync(join(root, 'renderer'), { recursive: true });
  writeFileSync(join(root, 'renderer', 'tray.html'), '<!doctype html>');
  writeFileSync(join(root, 'renderer', 'tray.css'), 'body{margin:0}');
  writeFileSync(join(root, 'renderer', 'tray.ts'), 'export const x = 1;');
  writeFileSync(join(root, 'renderer', 'notes.md'), '# notes');

  mkdirSync(join(root, 'assets', 'icons'), { recursive: true });
  writeFileSync(join(root, 'assets', 'icon.png'), 'top-level');
  writeFileSync(join(root, 'assets', 'icons', 'tray.png'), 'nested');

  // The pinned emoji webfont the build bundles for Linux.
  mkdirSync(
    join(root, 'node_modules', '@fontsource', 'noto-color-emoji', 'files'),
    { recursive: true },
  );
  writeFileSync(
    join(
      root,
      'node_modules',
      '@fontsource',
      'noto-color-emoji',
      'files',
      'noto-color-emoji-emoji-400-normal.woff2',
    ),
    'woff2-payload',
  );
  return root;
}

interface BuildRun {
  root: string;
  events: string[];
  bundles: { entry: string; outfile: string }[];
  staleAtFirstCompile: boolean | null;
}

async function build(root: string): Promise<BuildRun> {
  const events: string[] = [];
  const bundles: { entry: string; outfile: string }[] = [];
  let staleAtFirstCompile: boolean | null = null;
  await buildApp(root, {
    compile: (project) => {
      staleAtFirstCompile ??= existsSync(join(root, 'build', 'stale.txt'));
      events.push(`compile:${project}`);
    },
    bundlePreload: (entry, outfile) => {
      events.push('bundle');
      bundles.push({ entry, outfile });
      return Promise.resolve();
    },
  });
  return { root, events, bundles, staleAtFirstCompile };
}

describe('scripts/build.ts', () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  describe('buildApp', () => {
    it('compiles renderer first and node last, then bundles the preload', async () => {
      // Both projects emit src/ipc-contract and src/domain-types into
      // build/src and the main process must load the NodeNext emit, so the
      // node compile has to be the one that wins.
      const run = await build(makeRoot());
      expect(run.events).toEqual([
        'compile:tsconfig.renderer.json',
        'compile:tsconfig.node.json',
        'bundle',
      ]);
    });

    it('wipes the previous build BEFORE the first compile', async () => {
      // A compile into a half-stale build/ is exactly the failure this
      // ordering exists to prevent.
      const run = await build(makeRoot());
      expect(run.staleAtFirstCompile).toBe(false);
    });

    it('leaves nothing of the previous build behind', async () => {
      const run = await build(makeRoot());
      expect(existsSync(join(run.root, 'build', 'stale.txt'))).toBe(false);
      expect(existsSync(join(run.root, 'build', 'nested'))).toBe(false);
    });

    it('bundles the preload entry into build/src/preload.cjs', async () => {
      const run = await build(makeRoot());
      expect(run.bundles).toEqual([
        {
          entry: join(run.root, 'src', 'preload.ts'),
          outfile: join(run.root, 'build', 'src', 'preload.cjs'),
        },
      ]);
    });

    it('copies the renderer .html and .css the window loads as-is', async () => {
      const run = await build(makeRoot());
      expect(
        readFileSync(join(run.root, 'build', 'renderer', 'tray.html'), 'utf8'),
      ).toBe('<!doctype html>');
      expect(
        readFileSync(join(run.root, 'build', 'renderer', 'tray.css'), 'utf8'),
      ).toBe('body{margin:0}');
    });

    it('does NOT copy renderer sources into the build', async () => {
      // tsc owns the .ts emit; copying the source would ship it, and the
      // window would have two candidates for the same module.
      const run = await build(makeRoot());
      expect(existsSync(join(run.root, 'build', 'renderer', 'tray.ts'))).toBe(
        false,
      );
      expect(existsSync(join(run.root, 'build', 'renderer', 'notes.md'))).toBe(
        false,
      );
    });

    it('copies the bundled emoji webfont into build/assets/fonts', async () => {
      const run = await build(makeRoot());
      expect(
        readFileSync(
          join(run.root, 'build', 'assets', 'fonts', 'NotoColorEmoji.woff2'),
          'utf8',
        ),
      ).toBe('woff2-payload');
    });

    it('only warns when the emoji font is missing from node_modules', async () => {
      // A stale node_modules must still build a working app on systems with
      // their own emoji font — the warning is the visible trace.
      const root = makeRoot();
      rmSync(join(root, 'node_modules', '@fontsource'), {
        recursive: true,
        force: true,
      });
      const warnings: string[] = [];
      const spy = vi
        .spyOn(console, 'warn')
        .mockImplementation((message: unknown) => {
          warnings.push(String(message));
        });
      try {
        await build(root);
      } finally {
        spy.mockRestore();
      }
      expect(
        warnings.some((message) => message.includes('Noto Color Emoji')),
      ).toBe(true);
      expect(
        existsSync(
          join(root, 'build', 'assets', 'fonts', 'NotoColorEmoji.woff2'),
        ),
      ).toBe(false);
    });

    it('copies assets recursively, subdirectories included', async () => {
      const run = await build(makeRoot());
      expect(
        readFileSync(join(run.root, 'build', 'assets', 'icon.png'), 'utf8'),
      ).toBe('top-level');
      expect(
        readFileSync(
          join(run.root, 'build', 'assets', 'icons', 'tray.png'),
          'utf8',
        ),
      ).toBe('nested');
    });

    it('works when there is no previous build at all', async () => {
      const root = makeRoot();
      rmSync(join(root, 'build'), { recursive: true, force: true });
      const run = await build(root);
      expect(run.events).toHaveLength(3);
      expect(existsSync(join(run.root, 'build', 'renderer', 'tray.html'))).toBe(
        true,
      );
    });
  });

  describe('defaultBuildDeps', () => {
    it('runs the repo-local tsc with -p, from the build root', () => {
      // The root reaches tsc as the child's cwd (it used to reach it as a
      // process-wide chdir): a relative `-p tsconfig.*.json` only resolves
      // if the child actually starts there.
      const root = makeRoot();
      const bin = join(root, 'node_modules', 'typescript', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'tsc'),
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'),",
          "  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
        ].join('\n'),
      );
      chmodSync(join(bin, 'tsc'), 0o755);

      defaultBuildDeps(root).compile('tsconfig.renderer.json');

      const logged = readFileSync(join(bin, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
      expect(logged).toHaveLength(1);
      expect(logged[0]?.argv).toEqual(['-p', 'tsconfig.renderer.json']);
      expect(logged[0]?.cwd).toBe(realpathSync(root));
    });

    it('emits CommonJS and leaves electron to the runtime', async () => {
      // Dropping `external: ['electron']` does not degrade quietly: the
      // bundle would try to resolve electron from this throwaway root, which
      // has no node_modules, and the build would fail outright.
      const root = makeRoot();
      mkdirSync(join(root, 'src'), { recursive: true });
      const entry = join(root, 'src', 'preload.ts');
      writeFileSync(
        entry,
        [
          "import { ipcRenderer } from 'electron';",
          'export const ping = (): void => {',
          "  ipcRenderer.send('ping');",
          '};',
        ].join('\n'),
      );
      const outfile = join(root, 'build', 'src', 'preload.cjs');

      await defaultBuildDeps(root).bundlePreload(entry, outfile);

      const emitted = readFileSync(outfile, 'utf8');
      expect(emitted).toMatch(/require\(["']electron["']\)/);
      expect(emitted).toContain('module.exports');
      expect(emitted).not.toMatch(/^import /m);
    });
  });
});
