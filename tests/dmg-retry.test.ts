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
  harness: string;
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
# Only creation is flaky. Detaching a leftover volume is not what the retry is
# about, and letting it consume a failure would model something that does not
# happen — while making the count depend on the tester's mounted volumes.
if [ "\${1:-}" != create ]; then exit 0; fi
count=$(cat "$DMG_TEST_COUNT")
count=$((count + 1))
printf '%s' "$count" > "$DMG_TEST_COUNT"
if [ "$count" -le "$DMG_TEST_FAILURES" ]; then
  echo "hdiutil: create failed - Resource busy" >&2
  exit 1
fi
exit 0
`;

/*
 * Written to a FILE and handed to bash as an argument, never as a `bash -c`
 * program: building that program out of absolute paths (from `import.meta.url`
 * and `tmpdir()`) is what CodeQL flags as
 * js/shell-command-injection-from-environment. Paths arrive as environment
 * values the script reads, quoted, so none is ever interpreted.
 *
 * Invoking by path also keeps $0 different from the script under test, whose
 * entrypoint guard compares it with BASH_SOURCE — they must differ so sourcing
 * does not run a real build.
 */
const HARNESS = `set -uo pipefail
export PATH="$HARNESS_BIN:$PATH"
source "$HARNESS_SCRIPT"
create_dmg arm64 "$HARNESS_ROOT" "$HARNESS_OUT"
`;

async function fakeHdiutil(failures: number): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-dmg-'));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  await mkdir(binDirectory, { recursive: true });
  const fixture: Fixture = {
    binDirectory,
    harness: path.join(directory, 'harness.sh'),
    log: path.join(directory, 'calls.log'),
    counter: path.join(directory, 'count'),
    root: path.join(directory, 'root'),
    output: path.join(directory, 'out.dmg'),
    failures,
  };
  await writeFile(fixture.harness, HARNESS);
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
    await execFileAsync('bash', [fixture.harness], {
      env: {
        ...process.env,
        HARNESS_BIN: fixture.binDirectory,
        HARNESS_SCRIPT: script,
        HARNESS_ROOT: fixture.root,
        HARNESS_OUT: fixture.output,
        DMG_RETRY_DELAY: '0',
        DMG_TEST_LOG: fixture.log,
        DMG_TEST_COUNT: fixture.counter,
        DMG_TEST_FAILURES: String(fixture.failures),
      },
    });
  } catch (error: unknown) {
    code = Number((error as { code?: number }).code ?? 1);
  }
  const log = await readFile(fixture.log, 'utf8').catch(() => '');
  const calls = log.split('\n').filter(Boolean);
  // Only the create attempts. `detach_volume` also reaches hdiutil, but ONLY
  // when a volume of that exact name happens to be mounted on the machine
  // running the tests — counting every call made these assertions depend on
  // whether someone had a release DMG open.
  return { code, calls: calls.filter((call) => call.startsWith('create ')) };
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
