import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/auto-release.workflow.yml',
  'utf8',
);

describe('automatic release impact gating', () => {
  it('classifies each first-parent commit since the current release', () => {
    expect(workflow).toContain(
      'git rev-list --first-parent --reverse "${current_tag}..HEAD"',
    );
    expect(workflow).toContain('release-impact-policy.mjs');
    expect(workflow).toContain('git diff --name-only -z --no-renames');
    expect(workflow).toContain('release-impact-shas.txt');
  });

  it('uses release-impacting commit count for the threshold', () => {
    expect(workflow).toContain('commit_count=$(wc -l < "$impact_shas"');
    expect(workflow).toContain(
      '"$commit_count" -lt "$MINIMUM_COMMITS"',
    );
    expect(workflow).toContain('release-impacting commits since $current_tag');
    expect(workflow).not.toContain(
      'commit_count=$(git rev-list --count "${current_tag}..HEAD")',
    );
  });

  it('derives automatic version strategy only from impacting commits', () => {
    expect(workflow).toContain(
      'done < "$RUNNER_TEMP/release-impact-shas.txt"',
    );
    expect(workflow).toContain('release-impact-messages.txt');
    expect(workflow).toContain('release-impact-subjects.txt');
    expect(workflow).not.toContain(
      'git log "${CURRENT_TAG}..HEAD" --format=',
    );
  });

  it('keeps explicit force as a human override of the threshold', () => {
    expect(workflow).toContain('$FORCE_RELEASE" != "true"');
  });
});
