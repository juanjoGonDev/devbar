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

/**
 * Stands in for lsregister, recording what it was asked to withdraw. Real
 * lsregister writes to the machine's Launch Services database, which a test
 * has no business touching.
 */
const LSREGISTER_STUB = `#!/usr/bin/env bash
# One line per argument, never "$*": joining with spaces makes a path that got
# split indistinguishable from one that survived intact, so the assertion below
# could not fail on the very thing it exists to catch.
for arg in "$@"; do printf '%s\\n' "$arg" >> "$LS_TEST_LOG"; done
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

/**
 * Withdrawing everything a half-finished build left behind, which is the case
 * `unregister_bundle` alone does not cover: `fail()` exits before any tidying.
 */
const SWEEP_HARNESS = `set -uo pipefail
source "$HARNESS_SCRIPT"
withdraw_bundles_under "$HARNESS_DIR"
printf 'survived\\n'
`;

interface Fixture {
  harness: string;
  sweep: string;
  log: string;
  stub: string;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-lsreg-'));
  temporaryDirectories.push(directory);
  const built: Fixture = {
    harness: path.join(directory, 'harness.sh'),
    sweep: path.join(directory, 'sweep.sh'),
    log: path.join(directory, 'calls.log'),
    stub: path.join(directory, 'lsregister'),
  };
  await writeFile(built.harness, HARNESS);
  await writeFile(built.sweep, SWEEP_HARNESS);
  await writeFile(built.log, '');
  await writeFile(built.stub, LSREGISTER_STUB);
  await chmod(built.stub, 0o755);
  return built;
}

async function withdraw(
  built: Fixture,
  bundle: string,
  overrides: Record<string, string> = {},
): Promise<{ stdout: string; args: string[] }> {
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
  // Trailing newline only; an argument that is itself empty would show up as a
  // gap, which is what we want to see rather than silently drop.
  return { stdout, args: log.split('\n').slice(0, -1) };
}

async function sweep(
  built: Fixture,
  dir: string,
): Promise<{ stdout: string; withdrawn: string[] }> {
  const { stdout } = await execFileAsync('bash', [built.sweep], {
    env: {
      ...process.env,
      HARNESS_SCRIPT: script,
      HARNESS_DIR: dir,
      LSREGISTER: built.stub,
      LS_TEST_LOG: built.log,
    },
  });
  const log = await readFile(built.log, 'utf8');
  const args = log.split('\n').slice(0, -1);
  return { stdout, withdrawn: args.filter((arg) => arg !== '-u').sort() };
}

afterEach(async () => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe('withdraw_bundles_under', () => {
  it('sweeps every copy a build left behind, at any depth it uses', async () => {
    // What `fail()` leaves when hdiutil gives up: the packaged app and the
    // copy staged for the image, both already registered, both about to be
    // deleted by the next run without anyone withdrawing them.
    const built = await fixture();
    const work = await mkdtemp(path.join(tmpdir(), 'devbar-work-'));
    temporaryDirectories.push(work);
    const bundles = [
      path.join(work, 'package-arm64', 'DevBar-darwin-arm64', 'DevBar.app'),
      path.join(work, 'dmg-arm64', 'DevBar.app'),
    ];
    for (const bundle of bundles)
      await mkdir(path.join(bundle, 'Contents'), { recursive: true });

    const { withdrawn } = await sweep(built, work);
    expect(withdrawn).toEqual([...bundles].sort());
  });

  it('is a no-op when the build never got that far', async () => {
    const built = await fixture();
    const { stdout, withdrawn } = await sweep(built, '/nowhere/at/all');
    expect(withdrawn).toEqual([]);
    expect(stdout).toContain('survived');
  });
});

describe('unregister_bundle', () => {
  it('withdraws the bundle from Launch Services', async () => {
    const built = await fixture();
    const { args } = await withdraw(built, '/Volumes/DevBar 1.2.3/DevBar.app');
    expect(args).toEqual(['-u', '/Volumes/DevBar 1.2.3/DevBar.app']);
  });

  it('passes the path as one argument, spaces and all', async () => {
    // Volume names carry the version and the architecture: "DevBar 1.2.3
    // (arm64)". Unquoted, that would withdraw three paths that do not exist
    // and leave the real registration standing.
    const built = await fixture();
    const bundle = '/Volumes/DevBar 1.2.3 (arm64)/DevBar.app';
    const { args } = await withdraw(built, bundle);
    // Two arguments, not five: unquoted, the path would arrive as "DevBar",
    // "1.2.3" and "(arm64)/DevBar.app", withdrawing three registrations that
    // do not exist and leaving the real one standing.
    expect(args).toEqual(['-u', bundle]);
  });

  it('does not fail the release when lsregister fails', async () => {
    // A build that produced good artifacts must not be reported as broken
    // because a housekeeping call did not like something.
    const built = await fixture();
    const { stdout, args } = await withdraw(built, '/tmp/DevBar.app', {
      LS_TEST_EXIT: '1',
    });
    expect(args).toEqual(['-u', '/tmp/DevBar.app']);
    expect(stdout).toContain('survived');
  });

  it('is a no-op where lsregister does not exist', async () => {
    // The script is guarded to macOS, but sourcing it elsewhere — as these
    // tests do — must not blow up on a missing system binary.
    const built = await fixture();
    const { stdout, args } = await withdraw(built, '/tmp/DevBar.app', {
      LSREGISTER: path.join(path.dirname(built.stub), 'absent'),
    });
    expect(args).toEqual([]);
    expect(stdout).toContain('survived');
  });
});
