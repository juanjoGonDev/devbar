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
  steps?: WorkflowStep[];
}
const releaseWorkflowDoc = yaml.load(releaseWorkflow) as {
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

  it('keeps every cache-writable build job free of output-derived checkout refs', () => {
    // No checkout may use a ref derived from another job's outputs: in a
    // cache-writable workflow CodeQL treats those as untrusted code
    // (cache-poisoning alerts). Build jobs use the plain immutable
    // event-sha checkout; detect still resolves the version-introducing
    // commit, which the release tag targets.
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

  it('tags the release at the resolved commit via the explicit --target', () => {
    const stepNames = allSteps().map((step) => step.name);
    expect(stepNames).toContain('Checkout trusted default branch');
    expect(stepNames).toContain('Checkout release HEAD');
    expect(stepNames).toContain('Create immutable release tag');
    expect(stepNames).toContain('Verify published release');
    const releaseStep = allSteps().find(
      (step) => step.name === 'Create or validate GitHub release',
    );
    expect(
      releaseStep?.run ?? '',
      'the release must target the resolved commit, not the event SHA',
    ).toContain('--target "$RELEASE_SHA"');
    // Manual dispatch and the macOS release build remain part of the flow.
    const workflow = yaml.load(releaseWorkflow) as {
      on?: Record<string, unknown>;
    };
    expect(workflow.on?.workflow_dispatch !== undefined).toBe(true);
    expect(
      allSteps().some(
        (step) =>
          typeof step.run === 'string' &&
          step.run.includes('pnpm run release:mac'),
      ),
    ).toBe(true);
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
