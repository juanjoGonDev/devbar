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
 * macOS and Linux.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

export async function buildApp(): Promise<void> {
  process.chdir(ROOT);
  fs.rmSync(path.join(ROOT, 'build'), { recursive: true, force: true });

  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.renderer.json'], {
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.node.json'], {
    stdio: 'inherit',
  });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: path.join(ROOT, 'build', 'src', 'preload.cjs'),
  });

  const rendererOut = path.join(ROOT, 'build', 'renderer');
  fs.mkdirSync(rendererOut, { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, 'renderer'))) {
    if (name.endsWith('.html') || name.endsWith('.css')) {
      fs.copyFileSync(
        path.join(ROOT, 'renderer', name),
        path.join(rendererOut, name),
      );
    }
  }
  fs.cpSync(path.join(ROOT, 'assets'), path.join(ROOT, 'build', 'assets'), {
    recursive: true,
  });
}

// Direct execution: node --experimental-strip-types scripts/build.ts
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildApp().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
