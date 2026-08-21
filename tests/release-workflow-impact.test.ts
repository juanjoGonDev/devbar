import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const autoReleaseWorkflow = readFileSync(
  '.github/workflows/auto-release.workflow.yml',
  'utf8',
);
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const policyCommand =
  'node --experimental-strip-types scripts/release-impact-policy.ts';

describe('release impact workflow integration', () => {
  it('counts only release-impacting commits toward automatic releases', () => {
    expect(autoReleaseWorkflow).toContain(
      `${policyCommand} pending "$current_tag" HEAD`,
    );
    expect(autoReleaseWorkflow).toContain(
      "commit_count=$(jq -r '.commitCount' <<<\"$impact_json\")",
    );
    expect(autoReleaseWorkflow).toContain(
      'Only $commit_count release-impacting commits since $current_tag',
    );
    expect(autoReleaseWorkflow).not.toContain(
      'git rev-list --count "${current_tag}..HEAD"',
    );
  });

  it('derives automatic SemVer only from release-impacting commits', () => {
    expect(autoReleaseWorkflow).toContain(
      "mapfile -t release_commits < <(jq -r '.commits[]' <<<\"$impact_json\")",
    );
    expect(autoReleaseWorkflow).toContain(
      'git show -s --format=\'%s%n%b\' "$sha"',
    );
    expect(autoReleaseWorkflow).not.toContain(
      'git log "${CURRENT_TAG}..HEAD"',
    );
  });

  it('skips automatic installer publication without pending artifact impact', () => {
    expect(releaseWorkflow).toContain(
      'if [[ "$EVENT_NAME" != "workflow_dispatch" ]]; then',
    );
    expect(releaseWorkflow).toContain(
      `${policyCommand} pending "$latest_release_tag" "$release_sha"`,
    );
    expect(releaseWorkflow).toContain(
      'No release-impacting commits exist between $latest_release_tag and $release_sha; installer build skipped.',
    );
    expect(releaseWorkflow).toContain(
      "if: needs.detect.outputs.publish == 'true'",
    );
  });

  it('preserves exact release commit publication and explicit recovery', () => {
    expect(releaseWorkflow).toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain(
      'ref: ${{ needs.detect.outputs.release_sha }}',
    );
    expect(releaseWorkflow).toContain('pnpm run release:mac');
    expect(releaseWorkflow).toContain('Create immutable release tag');
    expect(releaseWorkflow).toContain('Create or validate GitHub release');
    expect(releaseWorkflow).toContain('Verify published release');
  });
});
