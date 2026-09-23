/**
 * Runtime helpers shared by the scripts/ entry points.
 *
 * Imported with the `.ts` extension on purpose: these scripts run BOTH
 * compiled (build/scripts/*.js, via tsc) and straight from source through
 * `node --experimental-strip-types`, and strip-types does NOT resolve a
 * `./x.js` specifier to `x.ts`. `rewriteRelativeImportExtensions`
 * (tsconfig.base.json) rewrites the extension on emit, so one source
 * specifier works in both modes.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A base directory taken from the environment, or `fallback`. Only a
 * non-empty ABSOLUTE value is honored: `??` alone lets an EMPTY string
 * through, and both an empty and a relative value resolve against the
 * process CWD — the script would then read, create or delete directories
 * inside the checkout while still reporting success.
 *
 * On win32 `path.isAbsolute` is `path.win32.isAbsolute`, which is exactly
 * the semantics the Windows variables (APPDATA, LOCALAPPDATA) need.
 */
export function absoluteEnvDir(name: string, fallback: string): string {
  const value = (process.env[name] ?? '').trim();
  return value !== '' && path.isAbsolute(value) ? value : fallback;
}

/**
 * True when `moduleUrl` (an `import.meta.url`) is the module Node was
 * started with — the guard that keeps a script's side effects out of a
 * test that imports it for its pure functions.
 *
 * Both sides are realpath-resolved: `import.meta.url` is already
 * symlink-resolved while `process.argv[1]` is not, so a checkout reached
 * through a symlinked directory (a linked ~/workspace, anything under
 * /tmp on macOS) makes a raw comparison FALSE and the script's main()
 * silently never runs. A path that cannot be resolved (deleted, EACCES)
 * is not the entrypoint either.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
