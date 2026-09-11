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
  it('the opening snapshot asks belongsToMergedScope', () => {
    expect(mainSource).toContain('belongsToMergedScope(parsed, groupId)');
  });

  it('the live stream asks belongsToMergedScope', () => {
    expect(mainSource).toContain(
      'belongsToMergedScope(parsed, mainLogsScope.groupId)',
    );
  });

  it('no competing membership helper survives alongside it', () => {
    // `mergedScopeGroupId` was the second, divergent answer.
    expect(mainSource).not.toContain('mergedScopeGroupId');
  });
});
