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
// but nothing there can prove both call sites actually ASK it. `src/main.ts`
// has no test seam in this repo, so this is a static-source contract over the
// shipped text — the same technique as `renderer-dom-contract.test.ts`.
const mainSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main.ts'),
  'utf8',
);

describe('both sides of a merged view share one membership rule', () => {
  // Each call passes the scope its own side holds, so the argument names
  // identify the call site without parsing the file.
  // `\s*,?\s*` before the closing paren tolerates a reflow that also adds a
  // trailing comma (this repo's Prettier 3 default for broken-out args), not
  // just one that adds whitespace.
  it('the opening snapshot asks belongsToMergedScope', () => {
    expect(mainSource).toMatch(
      /belongsToMergedScope\(\s*parsed,\s*groupId\s*,?\s*\)/,
    );
  });

  it('the live stream asks belongsToMergedScope', () => {
    expect(mainSource).toMatch(
      /belongsToMergedScope\(\s*parsed,\s*mainLogsScope\.groupId\s*,?\s*\)/,
    );
  });

  it('no competing membership helper survives alongside it', () => {
    // `mergedScopeGroupId` was the second, divergent answer.
    expect(mainSource).not.toContain('mergedScopeGroupId');
  });
});

describe('boot auto-start adopts an in-flight run without a window', () => {
  it('captures current() before awaiting run(), not after', () => {
    // Reading `current()` after the await loses a run that finished in
    // between, leaving the synthetic `already_running` result. `main.ts` has
    // no test seam, so this asserts the ORDER in the shipped source.
    const call = mainSource.indexOf('const attempt = preScriptRunner.run()');
    const capture = mainSource.indexOf('preScriptRunner.current()');
    const awaitAttempt = mainSource.indexOf('await attempt');
    expect(call).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(call);
    expect(awaitAttempt).toBeGreaterThan(capture);
  });
});
