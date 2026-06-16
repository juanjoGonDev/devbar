'use strict';

// Installs lefthook git hooks after `pnpm install`. No-ops in CI, in
// production installs, when there is no git repo, or when SKIP_GIT_HOOKS is
// set — so it never breaks non-developer environments. Adapted (JS/CJS) from
// the TypeScript version used in the Iteronix repo.

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

const skip =
  process.env.SKIP_GIT_HOOKS === 'true' ||
  process.env.CI === 'true' ||
  process.env.NODE_ENV === 'production' ||
  !existsSync('.git');

if (skip) {
  process.exit(0);
}

const win = process.platform === 'win32';

const gitCheck = spawnSync('git', ['--version'], {
  stdio: 'ignore',
  shell: win,
});
if (gitCheck.status !== 0) {
  process.exit(0);
}

const result = spawnSync('lefthook', ['install'], {
  stdio: 'inherit',
  shell: win,
});
process.exit(result.status ?? 1);
