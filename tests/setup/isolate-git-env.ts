/**
 * Vitest setup: forget every `GIT_*` variable the suite was started with.
 *
 * A git hook (lefthook pre-push → `pnpm quality`) runs with GIT_DIR, and from
 * a linked worktree also GIT_INDEX_FILE, GIT_COMMON_DIR and friends, exported
 * into its environment. git lets those override both `cwd` and `-C`, so a test
 * that builds a throwaway repository would otherwise commit, configure and tag
 * the real one instead. Deleting them here, before any test module loads,
 * covers every spawn at once: children inherit `process.env` unless a test
 * hands them an explicit env of its own. Variables a test sets later on
 * purpose are untouched, since this runs first.
 */
export function stripGitEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
}

stripGitEnv(process.env);
