'use strict';

const REQUIRED_WORKFLOWS = Object.freeze(['CI', 'CodeQL Advanced']);

function getLabelNames(pull) {
  return new Set((pull.labels || []).map((label) => label.name));
}

function classifyTrustedPull({ pull, repository, headSha }) {
  const labels = getLabelNames(pull);
  const sameRepository = pull.head.repo?.full_name === repository.full_name;
  const targetsDefaultBranch = pull.base.ref === repository.default_branch;

  if (pull.state !== 'open') return { eligible: false, reason: 'closed' };
  if (pull.draft) return { eligible: false, reason: 'draft' };
  if (pull.head.sha !== headSha) return { eligible: false, reason: 'stale-head' };
  if (!sameRepository) return { eligible: false, reason: 'foreign-head' };
  if (!targetsDefaultBranch) return { eligible: false, reason: 'wrong-base' };

  if (labels.has('auto-release') && pull.user?.login === repository.owner.login) {
    return {
      eligible: true,
      kind: 'release',
      requiredApprover: 'github-actions[bot]',
    };
  }

  if (
    labels.has('auto-merge-eligible') &&
    pull.user?.login === 'dependabot[bot]'
  ) {
    return {
      eligible: true,
      kind: 'dependabot',
      requiredApprover: repository.owner.login,
    };
  }

  return { eligible: false, reason: 'untrusted-policy' };
}

function hasCurrentApproval({ reviews, requiredApprover, headSha }) {
  return reviews.some(
    (review) =>
      review.user?.login === requiredApprover &&
      review.state === 'APPROVED' &&
      review.commit_id === headSha,
  );
}

function getLatestRequiredRuns({
  workflowRuns,
  headSha,
  requiredWorkflows = REQUIRED_WORKFLOWS,
}) {
  const latestRuns = new Map();

  for (const run of workflowRuns) {
    if (!requiredWorkflows.includes(run.name) || run.head_sha !== headSha) {
      continue;
    }

    const current = latestRuns.get(run.name);
    if (!current || run.run_number > current.run_number) {
      latestRuns.set(run.name, run);
    }
  }

  return latestRuns;
}

function getIncompleteRequiredWorkflows({
  workflowRuns,
  headSha,
  requiredWorkflows = REQUIRED_WORKFLOWS,
}) {
  const latestRuns = getLatestRequiredRuns({
    workflowRuns,
    headSha,
    requiredWorkflows,
  });

  return requiredWorkflows.filter((name) => {
    const run = latestRuns.get(name);
    return !run || run.status !== 'completed' || run.conclusion !== 'success';
  });
}

module.exports = {
  REQUIRED_WORKFLOWS,
  classifyTrustedPull,
  getIncompleteRequiredWorkflows,
  getLatestRequiredRuns,
  hasCurrentApproval,
};
