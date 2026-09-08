import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const skip =
  process.env.SKIP_GIT_HOOKS === 'true' ||
  process.env.CI === 'true' ||
  process.env.NODE_ENV === 'production' ||
  !existsSync('.git');
if (!skip) {
  const shell = process.platform === 'win32';
  if (
    spawnSync('git', ['--version'], { stdio: 'ignore', shell }).status === 0
  ) {
    const result = spawnSync('lefthook', ['install'], {
      stdio: 'inherit',
      shell,
    });
    process.exitCode = result.status ?? 1;
  }
}
