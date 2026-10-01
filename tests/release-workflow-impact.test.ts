import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { classifyReleaseImpact } from '../scripts/release-impact-policy.ts';

const autoReleaseWorkflow = readFileSync(
  '.github/workflows/auto-release.workflow.yml',
  'utf8',
);
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');

// Structural view of release.yml: the checkout/target invariants are
// asserted against the parsed workflow, not against global substrings
// (a comment or a differently-formatted line could satisfy the latter
// while violating the former).
interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}
interface WorkflowJob {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}
const releaseWorkflowDoc = yaml.load(releaseWorkflow) as {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, WorkflowJob>;
};
const jobSteps = (job: WorkflowJob): WorkflowStep[] => job.steps ?? [];
const allSteps = (): WorkflowStep[] =>
  Object.values(releaseWorkflowDoc.jobs).flatMap(jobSteps);
const cacheWritableJobs = (): [string, WorkflowJob][] =>
  Object.entries(releaseWorkflowDoc.jobs).filter(([, job]) =>
    jobSteps(job).some(
      (step) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/cache@') &&
        step.with != null &&
        step.with.path != null,
    ),
  );
const labelWorkflow = readFileSync(
  '.github/workflows/release-impact-label.workflow.yml',
  'utf8',
);
const releaseNotesConfig = readFileSync('.github/release.yml', 'utf8');
const policyCommand =
  'node --experimental-strip-types scripts/release-impact-policy.ts';
const nodeSetup = 'uses: actions/setup-node@';

describe('release impact workflow integration', () => {
  it('sets up Node before every workflow can execute the TypeScript policy', () => {
    const autoReleaseSetupIndex = autoReleaseWorkflow.indexOf(nodeSetup);
    const autoReleasePolicyIndex = autoReleaseWorkflow.indexOf(policyCommand);
    expect(autoReleaseSetupIndex).toBeGreaterThanOrEqual(0);
    expect(autoReleasePolicyIndex).toBeGreaterThan(autoReleaseSetupIndex);

    const releaseSetupIndex = releaseWorkflow.indexOf(nodeSetup);
    const releasePolicyIndex = releaseWorkflow.indexOf(policyCommand);
    expect(releaseSetupIndex).toBeGreaterThanOrEqual(0);
    expect(releasePolicyIndex).toBeGreaterThan(releaseSetupIndex);
  });

  it('labels pull requests from the same policy that gates releases', () => {
    const labelSetupIndex = labelWorkflow.indexOf(nodeSetup);
    const labelPolicyIndex = labelWorkflow.indexOf(policyCommand);
    expect(labelSetupIndex).toBeGreaterThanOrEqual(0);
    expect(labelPolicyIndex).toBeGreaterThan(labelSetupIndex);
    expect(labelWorkflow).toContain(
      `${policyCommand} range "$BASE_SHA" "$HEAD_SHA"`,
    );
  });

  it('recomputes the label on every pull request revision', () => {
    expect(labelWorkflow).toContain('pull_request_target:');
    expect(labelWorkflow).toContain('types: [opened, reopened, synchronize]');
  });

  it('never checks out the pull request head it labels', () => {
    expect(labelWorkflow).toContain(
      'ref: ${{ github.event.pull_request.base.sha }}',
    );
    expect(labelWorkflow).not.toContain(
      'ref: ${{ github.event.pull_request.head.sha }}',
    );
    expect(labelWorkflow).toContain('pull-requests: write');
  });

  it('drives the label in both directions', () => {
    expect(labelWorkflow).toContain('--add-label "$LABEL"');
    expect(labelWorkflow).toContain('--remove-label "$LABEL"');
  });

  it('excludes release-neutral pull requests from the generated notes', () => {
    expect(releaseNotesConfig).toContain('release-neutral');
  });

  it('counts only release-impacting commits toward automatic releases', () => {
    expect(autoReleaseWorkflow).toContain(
      `${policyCommand} pending "$current_tag" HEAD`,
    );
    expect(autoReleaseWorkflow).toContain(
      'commit_count=$(jq -r \'.commitCount\' <<<"$impact_json")',
    );
    expect(autoReleaseWorkflow).toContain(
      'Only $commit_count release-impacting commits since $current_tag',
    );
    expect(autoReleaseWorkflow).not.toContain(
      'git rev-list --count "${current_tag}..HEAD"',
    );
  });

  it('treats a draft current release as unreleased instead of a baseline', () => {
    const draftCheck = autoReleaseWorkflow.indexOf(
      'if [[ "$(jq -r .isDraft <<<"$current_release_json")" != "false" ]]; then',
    );
    expect(draftCheck).toBeGreaterThanOrEqual(0);
    const branch = autoReleaseWorkflow.slice(draftCheck, draftCheck + 400);
    expect(branch).toContain('echo "ready=false" >> "$GITHUB_OUTPUT"');
    expect(branch).toContain('exit 0');
    expect(autoReleaseWorkflow).toContain(
      'has no GitHub Release. Recover it before preparing another version.',
    );
  });

  it('derives automatic SemVer only from release-impacting commits', () => {
    expect(autoReleaseWorkflow).toContain(
      'mapfile -t release_commits < <(jq -r \'.commits[]\' <<<"$impact_json")',
    );
    expect(autoReleaseWorkflow).toContain(
      'git show -s --format=\'%s%n%b\' "$sha"',
    );
    expect(autoReleaseWorkflow).not.toContain('git log "${CURRENT_TAG}..HEAD"');
  });

  it('skips automatic installer publication without pending artifact impact', () => {
    expect(releaseWorkflow).toContain(
      `${policyCommand} pending "$latest_release_tag" "$GITHUB_SHA"`,
    );
    expect(releaseWorkflow).toContain(
      'node --experimental-strip-types scripts/release-decision.ts',
    );
    expect(releaseWorkflow).toContain(
      "if: needs.detect.outputs.publish == 'true'",
    );
  });

  it('keeps every cache-writable build job free of output-derived checkout refs', () => {
    // No checkout may use a ref derived from another job's outputs: in a
    // cache-writable workflow CodeQL treats those as untrusted code
    // (cache-poisoning alerts). Build jobs use the plain immutable
    // event-sha checkout, the same commit the release tag targets.
    const writable = cacheWritableJobs();
    expect(writable.length).toBeGreaterThanOrEqual(3);
    for (const [jobName, job] of writable) {
      const checkouts = jobSteps(job).filter(
        (step) =>
          typeof step.uses === 'string' &&
          step.uses.startsWith('actions/checkout@'),
      );
      expect(checkouts, `job ${jobName} must check out`).toHaveLength(1);
      const withBlock = checkouts[0].with;
      // A `ref` at all would be a formatting variant of the same
      // invariant — the build checkouts are plain event checkouts.
      expect(
        withBlock == null ? undefined : withBlock.ref,
        `job ${jobName} must not set a checkout ref`,
      ).toBeUndefined();
    }
    // A ref derived from job outputs must not appear in ANY checkout
    // step of the workflow (any formatting — parsed, not grepped).
    for (const step of allSteps()) {
      if (
        typeof step.uses !== 'string' ||
        !step.uses.startsWith('actions/checkout@')
      )
        continue;
      const ref = step.with?.ref;
      if (typeof ref === 'string')
        expect(
          ref,
          'checkout refs must not derive from job outputs',
        ).not.toMatch(/needs\./u);
    }
  });

  it('drafts the release at the event sha and keeps dispatch and the macOS build', () => {
    const draftStep = allSteps().find(
      (step) => step.name === 'Create draft release with every asset',
    );
    const draftRun = draftStep?.run ?? '';
    expect(draftRun).toContain('--draft');
    expect(
      draftRun,
      'build and tag must both be HEAD, the event sha',
    ).toContain('--target "$GITHUB_SHA"');
    // The version-introducing commit is gone as a tag/build target.
    expect(releaseWorkflow).not.toContain('outputs.release_sha');
    expect(releaseWorkflow).not.toContain('RELEASE_SHA');
    expect(releaseWorkflowDoc.on?.workflow_dispatch !== undefined).toBe(true);
    expect(
      allSteps().some(
        (step) =>
          typeof step.run === 'string' &&
          step.run.includes('pnpm run release:mac'),
      ),
    ).toBe(true);
  });

  it('lets a newer push cancel the in-flight release', () => {
    expect(releaseWorkflowDoc.concurrency).toEqual({
      group: 'release-${{ github.repository }}',
      'cancel-in-progress': true,
    });
  });

  it('uploads and verifies everything as a draft and publishes as the very last step', () => {
    const publishSteps = jobSteps(releaseWorkflowDoc.jobs.publish ?? {});
    const names = publishSteps.map((step) => step.name);
    const order = [
      'Verify the release set against SHA256SUMS',
      'Remove unpublished leftovers of an interrupted run',
      'Create draft release with every asset',
      'Verify draft assets against SHA256SUMS',
      'Publish the verified draft',
    ].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(names.at(-1)).toBe('Publish the verified draft');

    // Only the final step may publish; nothing earlier creates the tag.
    const publishing = publishSteps.filter(
      (step) =>
        typeof step.run === 'string' &&
        (step.run.includes('draft=false') ||
          step.run.includes('--method POST')),
    );
    expect(publishing.map((step) => step.name)).toEqual([
      'Publish the verified draft',
    ]);
    // The publish job sits after every build and the assembled set.
    const needs = releaseWorkflowDoc.jobs.publish?.needs ?? [];
    expect(needs).toContain('assemble');
  });

  it('cleans up only after a cancellation or failure of the publish chain', () => {
    const cleanup = releaseWorkflowDoc.jobs.cleanup;
    expect(cleanup).toBeDefined();
    expect(cleanup?.if).toBe(
      "(cancelled() || failure()) && needs.detect.outputs.publish == 'true'",
    );
    expect(cleanup?.needs).toEqual([
      'detect',
      'build-macos',
      'build-windows',
      'build-linux',
      'assemble',
      'publish',
    ]);
    expect(cleanup?.permissions).toEqual({ contents: 'write' });
  });

  it('never lets the cleanup touch a published release', () => {
    const run = jobSteps(releaseWorkflowDoc.jobs.cleanup ?? {})
      .map((step) => step.run ?? '')
      .join('\n');
    const guard = run.indexOf('any(.[]; .draft == false)');
    const firstDelete = run.indexOf('--method DELETE');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(firstDelete, 'the published guard must run first').toBeGreaterThan(
      guard,
    );
    expect(run.slice(guard, firstDelete)).toContain('exit 0');
    // It deletes only drafts this run created, never edits a release.
    expect(run).toContain('select(.draft and .target_commitish == $sha)');
    expect(run).not.toContain('--method PATCH');
    expect(run).not.toContain('gh release edit');
    expect(run).not.toContain('gh release delete');
  });

  // The policy decides whether a change needs a release; release-validation.yml
  // decides whether that change gets a packaging dry run. If a script the
  // policy calls release-impacting is missing from the workflow filter, it
  // ships without ever being dry-run. Both lists have silently drifted before,
  // so assert the containment instead of trusting two hand-maintained copies.
  it('dry-runs every release-impacting script in release-validation.yml', () => {
    const validationDoc = yaml.load(
      readFileSync('.github/workflows/release-validation.yml', 'utf8'),
    ) as { on?: { pull_request?: { paths?: string[] } } };
    const filtered = new Set(validationDoc.on?.pull_request?.paths ?? []);
    expect(filtered.size).toBeGreaterThan(0);

    // --others so a newly added, not-yet-committed script is covered too:
    // that is exactly when the two lists drift apart.
    const trackedScripts = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', 'scripts/'],
      { encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter((path) => path.length > 0);
    expect(trackedScripts.length).toBeGreaterThan(0);

    const uncovered = trackedScripts.filter(
      (path) =>
        classifyReleaseImpact([path]).publish === true && !filtered.has(path),
    );
    expect(
      uncovered,
      'release-impacting scripts missing from the release-validation.yml path filter',
    ).toEqual([]);
  });
});
