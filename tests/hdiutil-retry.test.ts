import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const script = path.join(repositoryRoot, 'scripts', 'verify-macos-release.sh');
const temporaryDirectories: string[] = [];

/**
 * Stands in for hdiutil, reproducing the transient the CI runner hit: the first
 * `HD_TEST_FAILURES` calls fail with "Resource temporarily unavailable", then
 * it succeeds. Paths arrive through the environment, so nothing is interpolated
 * into a shell command.
 */
const HDIUTIL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HD_TEST_LOG"
count=$(cat "$HD_TEST_COUNT")
count=$((count + 1))
printf '%s' "$count" > "$HD_TEST_COUNT"
if [ "$count" -le "$HD_TEST_FAILURES" ]; then
  echo "hdiutil: verify failed - Resource temporarily unavailable" >&2
  exit 1
fi
exit 0
`;

// $0 must differ from the script path: the entrypoint guard compares the two,
// and they have to disagree so sourcing does not verify a real release.
const HARNESS = `set -uo pipefail
export PATH="$1:$PATH"
source "$2"
hdiutil_retry "test verify" hdiutil verify /nowhere.dmg
`;

interface Fixture {
  binDirectory: string;
  log: string;
  counter: string;
}

async function fakeHdiutil(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-hdiutil-'));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  await mkdir(binDirectory, { recursive: true });
  const fixture: Fixture = {
    binDirectory,
    log: path.join(directory, 'calls.log'),
    counter: path.join(directory, 'count'),
  };
  await writeFile(fixture.counter, '0');
  await writeFile(path.join(binDirectory, 'hdiutil'), HDIUTIL_STUB);
  await chmod(path.join(binDirectory, 'hdiutil'), 0o755);
  return fixture;
}

async function runRetry(
  fixture: Fixture,
  failures: number,
): Promise<{ code: number; calls: string[] }> {
  let code = 0;
  try {
    await execFileAsync(
      'bash',
      ['-c', HARNESS, 'devbar-hdiutil-harness', fixture.binDirectory, script],
      {
        env: {
          ...process.env,
          HDIUTIL_RETRY_DELAY: '0',
          HD_TEST_LOG: fixture.log,
          HD_TEST_COUNT: fixture.counter,
          HD_TEST_FAILURES: String(failures),
        },
      },
    );
  } catch (error: unknown) {
    code = Number((error as { code?: number }).code ?? 1);
  }
  const log = await readFile(fixture.log, 'utf8').catch(() => '');
  return { code, calls: log.split('\n').filter(Boolean) };
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('release verification hdiutil retry', () => {
  it('calls hdiutil once when it is healthy', async () => {
    const { code, calls } = await runRetry(await fakeHdiutil(), 0);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('retries past a transient failure and still succeeds', async () => {
    const { code, calls } = await runRetry(await fakeHdiutil(), 2);
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('gives up on the attempt budget instead of retrying forever', async () => {
    const { code, calls } = await runRetry(await fakeHdiutil(), 99);
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('passes the arguments through untouched', async () => {
    const { calls } = await runRetry(await fakeHdiutil(), 0);
    expect(calls[0]).toBe('verify /nowhere.dmg');
  });
});
