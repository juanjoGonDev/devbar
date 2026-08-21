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
const script = path.join(repositoryRoot, 'scripts', 'build-macos-release.sh');
const temporaryDirectories: string[] = [];

interface Fixture {
  binDirectory: string;
  log: string;
  counter: string;
  root: string;
  output: string;
  failures: number;
}

/**
 * Stands in for hdiutil: fails the first `DMG_TEST_FAILURES` invocations, then
 * succeeds. Every call appends its arguments to a log the test can inspect.
 * Paths reach it through the environment, so nothing is interpolated into a
 * shell command.
 */
const HDIUTIL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DMG_TEST_LOG"
count=$(cat "$DMG_TEST_COUNT")
count=$((count + 1))
printf '%s' "$count" > "$DMG_TEST_COUNT"
if [ "$count" -le "$DMG_TEST_FAILURES" ]; then
  echo "hdiutil: create failed - Resource busy" >&2
  exit 1
fi
exit 0
`;

// $0 is deliberately not the script path: the entrypoint guard compares it with
// BASH_SOURCE, and they must differ so sourcing does not run a real build.
const HARNESS = `set -uo pipefail
export PATH="$1:$PATH"
source "$2"
create_dmg arm64 "$3" "$4"
`;

async function fakeHdiutil(failures: number): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-dmg-'));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  await mkdir(binDirectory, { recursive: true });
  const fixture: Fixture = {
    binDirectory,
    log: path.join(directory, 'calls.log'),
    counter: path.join(directory, 'count'),
    root: path.join(directory, 'root'),
    output: path.join(directory, 'out.dmg'),
    failures,
  };
  await writeFile(fixture.counter, '0');
  await writeFile(path.join(binDirectory, 'hdiutil'), HDIUTIL_STUB);
  await chmod(path.join(binDirectory, 'hdiutil'), 0o755);
  return fixture;
}

async function runCreateDmg(
  fixture: Fixture,
): Promise<{ code: number; calls: string[] }> {
  let code = 0;
  try {
    await execFileAsync(
      'bash',
      [
        '-c',
        HARNESS,
        'devbar-dmg-harness',
        fixture.binDirectory,
        script,
        fixture.root,
        fixture.output,
      ],
      {
        env: {
          ...process.env,
          DMG_RETRY_DELAY: '0',
          DMG_TEST_LOG: fixture.log,
          DMG_TEST_COUNT: fixture.counter,
          DMG_TEST_FAILURES: String(fixture.failures),
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

describe('DMG creation', () => {
  it('succeeds first time when hdiutil is healthy', async () => {
    const { code, calls } = await runCreateDmg(await fakeHdiutil(0));
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('retries past a transient "Resource busy" and still succeeds', async () => {
    const { code, calls } = await runCreateDmg(await fakeHdiutil(2));
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('gives up after the attempt budget instead of retrying forever', async () => {
    const { code, calls } = await runCreateDmg(await fakeHdiutil(99));
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('skips Spotlight indexing, which is one cause of the collision', async () => {
    const { calls } = await runCreateDmg(await fakeHdiutil(0));
    expect(calls[0]).toContain('-nospotlight');
  });
});
