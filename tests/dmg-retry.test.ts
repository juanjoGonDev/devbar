import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
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
 * Stands in for hdiutil: fails the first `failures` invocations, then succeeds.
 * Every call appends its arguments to a log so the test can inspect them.
 */
async function fakeHdiutil(failures: number): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'devbar-dmg-'));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  const log = path.join(directory, 'calls.log');
  const counter = path.join(directory, 'count');
  await execFileAsync('mkdir', ['-p', binDirectory]);
  await writeFile(counter, '0');
  const stub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
count=$(cat ${JSON.stringify(counter)})
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(counter)}
if [ "$count" -le ${failures} ]; then
  echo "hdiutil: create failed - Resource busy" >&2
  exit 1
fi
exit 0
`;
  await writeFile(path.join(binDirectory, 'hdiutil'), stub);
  await chmod(path.join(binDirectory, 'hdiutil'), 0o755);
  return directory;
}

async function runCreateDmg(
  fixture: string,
): Promise<{ code: number; calls: string[] }> {
  const harness = `set -uo pipefail
export PATH=${JSON.stringify(path.join(fixture, 'bin'))}:"$PATH"
export DMG_RETRY_DELAY=0
source ${JSON.stringify(script)}
create_dmg arm64 ${JSON.stringify(path.join(fixture, 'root'))} ${JSON.stringify(path.join(fixture, 'out.dmg'))}
`;
  let code = 0;
  try {
    await execFileAsync('bash', ['-c', harness]);
  } catch (error: unknown) {
    code = Number((error as { code?: number }).code ?? 1);
  }
  const log = await readFile(path.join(fixture, 'calls.log'), 'utf8').catch(
    () => '',
  );
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
