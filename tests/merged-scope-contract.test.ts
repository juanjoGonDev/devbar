import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A merged log view answers "does this process belong here?" twice: once when
// it opens (`collectMergedSources`) and once per line while it is open
// (`broadcastLog`). Those two answers were written separately and drifted —
// the pipeline view listed every pre-script's buffer and then received none
// of their lines, so it only filled in on reload.
//
// `belongsToMergedScope` is unit-tested per scope in `compound-id.test.ts`,
// and each call site now has its own suite — but a behavioural test proves
// what one side does, never that BOTH ask the same question. That is what
// drifted, so it stays a static-source contract over the shipped text — the
// same technique as `renderer-dom-contract.test.ts`.
const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const read = (rel: string): string =>
  fs.readFileSync(path.join(repoDir, rel), 'utf8');
/** The view's opening snapshot. */
const snapshotSource = read('src/main/ipc/logs-ipc.ts');
/** The live line stream into the open window. */
const streamSource = read('src/main/log-windows.ts');

describe('both sides of a merged view share one membership rule', () => {
  // Each call passes the scope its own side holds, so the argument names
  // identify the call site without parsing the file.
  // `\s*,?\s*` before the closing paren tolerates a reflow that also adds a
  // trailing comma (this repo's Prettier 3 default for broken-out args), not
  // just one that adds whitespace.
  it('the opening snapshot asks belongsToMergedScope', () => {
    expect(snapshotSource).toMatch(
      /belongsToMergedScope\(\s*parsed,\s*groupId\s*,?\s*\)/,
    );
  });

  it('the live stream asks belongsToMergedScope', () => {
    expect(streamSource).toMatch(
      /belongsToMergedScope\(\s*parsed,\s*mainLogsScope\.groupId\s*,?\s*\)/,
    );
  });

  it('no competing membership helper survives alongside it', () => {
    // `mergedScopeGroupId` was the second, divergent answer.
    expect(snapshotSource).not.toContain('mergedScopeGroupId');
    expect(streamSource).not.toContain('mergedScopeGroupId');
  });
});

describe('boot auto-start adopts an in-flight run without a window', () => {
  it('captures current() before awaiting run(), not after', () => {
    // Reading `current()` after the await loses a run that finished in
    // between, leaving the synthetic `already_running` result. No behavioural
    // test can pin that window shut, so this asserts the ORDER in the source.
    const bootSource = read('src/main/startup.ts');
    const call = bootSource.indexOf('const attempt = preScriptRunner.run()');
    const capture = bootSource.indexOf('preScriptRunner.current()');
    const awaitAttempt = bootSource.indexOf('await attempt');
    expect(call).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(call);
    expect(awaitAttempt).toBeGreaterThan(capture);
  });
});
