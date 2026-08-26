import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * Stands in for lsregister, recording what it was asked to withdraw. Real
 * lsregister writes to the machine's Launch Services database, which a test
 * has no business touching.
 */
const LSREGISTER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LS_TEST_LOG"
exit "\${LS_TEST_EXIT:-0}"
`;

/*
 * The harness is written to a FILE and handed to bash as an argument, never as
 * a \`bash -c\` program: building that program out of absolute paths is what
 * CodeQL flags as js/shell-command-injection-from-environment. Paths arrive as
 * environment values the script reads, quoted, so none is ever interpreted.
 *
 * Invoking by path also keeps $0 different from the script under test, whose
 * entrypoint guard compares the two — they have to disagree so sourcing does
 * not start building a real release.
 */
const HARNESS = `set -uo pipefail
source "$HARNESS_SCRIPT"
unregister_bundle "$HARNESS_BUNDLE"
printf 'survived\\n'
`;

interface Fixture {
  harness: string;
  log: string;
  stub: string;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-lsreg-'));
  temporaryDirectories.push(directory);
  const built: Fixture = {
    harness: path.join(directory, 'harness.sh'),
    log: path.join(directory, 'calls.log'),
    stub: path.join(directory, 'lsregister'),
  };
  await writeFile(built.harness, HARNESS);
  await writeFile(built.log, '');
  await writeFile(built.stub, LSREGISTER_STUB);
  await chmod(built.stub, 0o755);
  return built;
}

async function withdraw(
  built: Fixture,
  bundle: string,
  overrides: Record<string, string> = {},
): Promise<{ stdout: string; calls: string[] }> {
  const { stdout } = await execFileAsync('bash', [built.harness], {
    env: {
      ...process.env,
      HARNESS_SCRIPT: script,
      HARNESS_BUNDLE: bundle,
      LSREGISTER: built.stub,
      LS_TEST_LOG: built.log,
      ...overrides,
    },
  });
  const log = await readFile(built.log, 'utf8');
  return { stdout, calls: log.split('\n').filter(Boolean) };
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('unregister_bundle', () => {
  it('withdraws the bundle from Launch Services', async () => {
    const built = await fixture();
    const { calls } = await withdraw(built, '/Volumes/DevBar 1.2.3/DevBar.app');
    expect(calls).toEqual(['-u /Volumes/DevBar 1.2.3/DevBar.app']);
  });

  it('passes the path as one argument, spaces and all', async () => {
    // Volume names carry the version and the architecture: "DevBar 1.2.3
    // (arm64)". Unquoted, that would withdraw three paths that do not exist
    // and leave the real registration standing.
    const built = await fixture();
    const { calls } = await withdraw(
      built,
      '/Volumes/DevBar 1.2.3 (arm64)/DevBar.app',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('-u /Volumes/DevBar 1.2.3 (arm64)/DevBar.app');
  });

  it('does not fail the release when lsregister fails', async () => {
    // A build that produced good artifacts must not be reported as broken
    // because a housekeeping call did not like something.
    const built = await fixture();
    const { stdout, calls } = await withdraw(built, '/tmp/DevBar.app', {
      LS_TEST_EXIT: '1',
    });
    expect(calls).toHaveLength(1);
    expect(stdout).toContain('survived');
  });

  it('is a no-op where lsregister does not exist', async () => {
    // The script is guarded to macOS, but sourcing it elsewhere — as these
    // tests do — must not blow up on a missing system binary.
    const built = await fixture();
    const { stdout, calls } = await withdraw(built, '/tmp/DevBar.app', {
      LSREGISTER: path.join(path.dirname(built.stub), 'absent'),
    });
    expect(calls).toEqual([]);
    expect(stdout).toContain('survived');
  });
});
