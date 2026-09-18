/**
 * Development build — the Node port of the old scripts/build.sh (which only
 * worked where a real bash exists; on Windows `bash` is often a POSIX sh
 * without `pipefail` and the script died on `set -euo pipefail`).
 *
 * Renderer first: both projects emit src/ipc-contract and src/domain-types
 * into build/src, and the main process must load the NodeNext (node project)
 * emit, so the node compile runs last and wins. The renderer never loads
 * those files at runtime (type-only imports).
 *
 * tsc runs through node directly (node_modules/typescript/bin/tsc) so no
 * shell or .bin shim resolution is involved — identical output on Windows,
 * macOS and Linux. It is handed `cwd: root` rather than the process being
 * chdir'd into it: the relative `-p tsconfig.*.json` resolves the same way,
 * without a build script mutating the cwd of whatever started it.
 *
 * The two expensive steps (tsc, esbuild) are injected so the copy/clean
 * choreography around them — what is wiped, what order the projects compile
 * in, which renderer files ship — is testable without a real compile.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { isEntrypoint } from './lib/script-runtime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface BuildDeps {
  /** Compile one tsconfig project, resolved against the build root. */
  compile: (project: string) => void;
  /** Bundle the preload entry point into a single CommonJS file. */
  bundlePreload: (entry: string, outfile: string) => Promise<void>;
}

/** The real toolchain: the repo's own tsc and esbuild. */
export function defaultBuildDeps(root: string): BuildDeps {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  return {
    compile: (project) => {
      execFileSync(process.execPath, [tsc, '-p', project], {
        stdio: 'inherit',
        cwd: root,
      });
    },
    bundlePreload: async (entry, outfile) => {
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        // Electron is provided by the runtime, not by the bundle.
        external: ['electron'],
        outfile,
      });
    },
  };
}

export async function buildApp(
  root: string = ROOT,
  deps: BuildDeps = defaultBuildDeps(root),
): Promise<void> {
  fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });

  deps.compile('tsconfig.renderer.json');
  deps.compile('tsconfig.node.json');

  await deps.bundlePreload(
    path.join(root, 'src', 'preload.ts'),
    path.join(root, 'build', 'src', 'preload.cjs'),
  );

  const rendererOut = path.join(root, 'build', 'renderer');
  fs.mkdirSync(rendererOut, { recursive: true });
  for (const name of fs.readdirSync(path.join(root, 'renderer'))) {
    // Only the assets the window loads as-is: the renderer's .ts sources are
    // the tsc emit's job, and copying them would ship source into the build.
    if (name.endsWith('.html') || name.endsWith('.css')) {
      fs.copyFileSync(
        path.join(root, 'renderer', name),
        path.join(rendererOut, name),
      );
    }
  }
  fs.cpSync(path.join(root, 'assets'), path.join(root, 'build', 'assets'), {
    recursive: true,
  });
}

// Direct execution: node --experimental-strip-types scripts/build.ts
if (isEntrypoint(import.meta.url)) {
  buildApp().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
