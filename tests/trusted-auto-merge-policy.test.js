import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  REQUIRED_WORKFLOWS,
  classifyTrustedPull,
  getIncompleteRequiredWorkflows,
  getLatestRequiredRuns,
  hasCurrentApproval,
} = require('../scripts/trusted-auto-merge-policy.cjs');

const HEAD_SHA = 'abc123';
const REPOSITORY = {
  full_name: 'juanjoGonDev/devbar',
  default_branch: 'main',
  owner: { login: 'juanjoGonDev' },
};

function createPull(overrides = {}) {
  return {
    state: 'open',
    draft: false,
    head: {
      sha: HEAD_SHA,
      repo: { full_name: REPOSITORY.full_name },
    },
    base: { ref: REPOSITORY.default_branch },
    user: { login: REPOSITORY.owner.login },
    labels: [{ name: 'auto-release' }],
    ...overrides,
  };
}

function createRun(name, overrides = {}) {
  return {
    name,
    head_sha: HEAD_SHA,
    run_number: 1,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

describe('classifyTrustedPull', () => {
  it('accepts a repository-owner release pull request', () => {
    expect(
      classifyTrustedPull({
        pull: createPull(),
        repository: REPOSITORY,
        headSha: HEAD_SHA,
      }),
    ).toEqual({
      eligible: true,
      kind: 'release',
      requiredApprover: 'github-actions[bot]',
    });
  });

  it('accepts a labeled Dependabot update', () => {
    const pull = createPull({
      user: { login: 'dependabot[bot]' },
      labels: [{ name: 'auto-merge-eligible' }],
    });

    expect(
      classifyTrustedPull({ pull, repository: REPOSITORY, headSha: HEAD_SHA }),
    ).toEqual({
      eligible: true,
      kind: 'dependabot',
      requiredApprover: REPOSITORY.owner.login,
    });
  });

  it.each([
    ['closed', { state: 'closed' }, 'closed'],
    ['draft', { draft: true }, 'draft'],
    ['stale head', { head: { sha: 'old', repo: { full_name: REPOSITORY.full_name } } }, 'stale-head'],
    ['foreign head', { head: { sha: HEAD_SHA, repo: { full_name: 'attacker/fork' } } }, 'foreign-head'],
    ['wrong base', { base: { ref: 'develop' } }, 'wrong-base'],
    ['untrusted actor', { user: { login: 'other-user' } }, 'untrusted-policy'],
    ['missing policy label', { labels: [] }, 'untrusted-policy'],
  ])('rejects %s', (_name, overrides, reason) => {
    expect(
      classifyTrustedPull({
        pull: createPull(overrides),
        repository: REPOSITORY,
        headSha: HEAD_SHA,
      }),
    ).toEqual({ eligible: false, reason });
  });
});

describe('hasCurrentApproval', () => {
  it('requires the expected actor and exact current head', () => {
    const reviews = [
      {
        user: { login: 'github-actions[bot]' },
        state: 'APPROVED',
        commit_id: HEAD_SHA,
      },
    ];

    expect(
      hasCurrentApproval({
        reviews,
        requiredApprover: 'github-actions[bot]',
        headSha: HEAD_SHA,
      }),
    ).toBe(true);
    expect(
      hasCurrentApproval({
        reviews,
        requiredApprover: 'juanjoGonDev',
        headSha: HEAD_SHA,
      }),
    ).toBe(false);
    expect(
      hasCurrentApproval({
        reviews,
        requiredApprover: 'github-actions[bot]',
        headSha: 'new-head',
      }),
    ).toBe(false);
  });
});

describe('required workflow gates', () => {
  it('returns no incomplete workflows when all latest runs pass', () => {
    const workflowRuns = REQUIRED_WORKFLOWS.map((name) => createRun(name));

    expect(
      getIncompleteRequiredWorkflows({ workflowRuns, headSha: HEAD_SHA }),
    ).toEqual([]);
  });

  it('reports missing, pending, and failed workflows', () => {
    expect(
      getIncompleteRequiredWorkflows({ workflowRuns: [], headSha: HEAD_SHA }),
    ).toEqual(REQUIRED_WORKFLOWS);

    expect(
      getIncompleteRequiredWorkflows({
        workflowRuns: [createRun('CI', { status: 'in_progress', conclusion: null })],
        headSha: HEAD_SHA,
      }),
    ).toEqual(REQUIRED_WORKFLOWS);

    expect(
      getIncompleteRequiredWorkflows({
        workflowRuns: [
          createRun('CI'),
          createRun('CodeQL Advanced', { conclusion: 'failure' }),
        ],
        headSha: HEAD_SHA,
      }),
    ).toEqual(['CodeQL Advanced']);
  });

  it('uses the latest run for the exact head only', () => {
    const workflowRuns = [
      createRun('CI', { run_number: 1 }),
      createRun('CI', { run_number: 2, conclusion: 'failure' }),
      createRun('CodeQL Advanced'),
      createRun('CI', { head_sha: 'different-head', run_number: 99 }),
      createRun('Unrelated Workflow', { run_number: 100 }),
    ];

    const latestRuns = getLatestRequiredRuns({
      workflowRuns,
      headSha: HEAD_SHA,
    });

    expect(latestRuns.get('CI').run_number).toBe(2);
    expect(latestRuns.has('Unrelated Workflow')).toBe(false);
    expect(
      getIncompleteRequiredWorkflows({ workflowRuns, headSha: HEAD_SHA }),
    ).toEqual(['CI']);
  });
});
