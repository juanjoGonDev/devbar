# DevBar release lockfile and trusted auto-merge repair

## Request

Restore pull request #31, determine why its expected auto-merge did not occur, and make trusted release and Dependabot automation wait for the required validation gates.

## Evidence

- CI run `30531092681` initially failed because `pnpm-lock.yaml` contained a duplicated `fdir@6.5.0(picomatch@4.0.5)` snapshot.
- After repairing the lockfile, CI exposed an independent Prettier failure in the generated CodeQL workflow.
- Pull request #31 eventually passed CI and CodeQL but remained open because the trusted release pull-request job only approved the current head.
- `.github/workflows/auto-release.workflow.yml` attempted `gh pr merge --auto` only once, immediately after creating the release pull request.
- `.github/workflows/dependabot-auto-merge.workflow.yml` also used `gh pr merge --auto` for eligible Dependabot updates.
- The repository allows auto-merge but does not enforce CI and CodeQL as required branch checks.
- Enabling GitHub auto-merge without required checks therefore merged pull request #31 immediately instead of waiting for its in-progress CI run.
- CI run `30540512244` subsequently failed only because this specification lacked its final newline; the application and workflow logic were not executed after that failure.

## Decision

- Keep the repaired lockfile and hardened CodeQL workflow.
- Remove direct `gh pr merge --auto` calls from release creation and Dependabot eligibility workflows.
- Keep trusted release approval separate from merge execution.
- Mark eligible patch and minor Dependabot updates with `auto-merge-eligible` after owner approval.
- Add a privileged `workflow_run` gate sourced from the default branch. It never checks out or executes pull-request-controlled code.
- Require successful `CI` and `CodeQL Advanced` runs for the exact pull-request head SHA before squash merging.
- Revalidate pull-request state and head SHA immediately before merge to prevent races.
- Extract eligibility, approval, and workflow-run selection into a pure CommonJS policy module with Vitest coverage.

## Trust contract

A release pull request is eligible only when all of these conditions hold:

- The repository is not a fork.
- The head belongs to this repository.
- The base is the default branch.
- The author is the repository owner.
- The pull request has the `auto-release` label.
- `github-actions[bot]` approved the exact current head.

A Dependabot pull request is eligible only when all of these conditions hold:

- The repository is not a fork.
- The head belongs to this repository.
- The base is the default branch.
- The author is `dependabot[bot]`.
- The update policy classified it as patch or minor.
- The pull request has the `auto-merge-eligible` label.
- The repository owner approved the exact current head through `PAT_FINE`.

Both paths additionally require the latest `CI` and `CodeQL Advanced` runs for the exact head SHA to be completed successfully.

## Acceptance criteria

- `pnpm install --frozen-lockfile` succeeds.
- Lint, Prettier, dead-code analysis, dependency architecture, tests, packaging, and CodeQL pass.
- Release creation does not request GitHub auto-merge directly.
- Dependabot eligibility does not request GitHub auto-merge directly.
- No trusted pull request can merge while CI or CodeQL is missing, pending, cancelled, or failing.
- Stale approvals and workflow runs from another SHA do not satisfy the gate.
- Fork heads, drafts, wrong-base pull requests, and untrusted actors are rejected.
- The final merge uses squash and an exact expected head SHA.

## Validation

- Policy tests cover release and Dependabot eligibility, every rejection guard, exact-head approvals, missing workflows, pending workflows, failed workflows, unrelated workflows, stale SHAs, and latest-run precedence.
- CI run `30541592058` passed frozen installation, lint, Prettier, Knip, dependency-cruiser, the full Vitest suite, and application packaging on the clean corrective head.
- CodeQL run `30541592034` passed both `actions` and `javascript-typescript` analysis on the same head.
- The temporary formatting workflow was removed from the final diff.
- The post-CI merge workflow can be exercised only after it exists on the default branch; its runtime contract is guarded by the tested policy and exact-SHA checks.

## Delivery

- Corrective branch: `agent/fix-release-auto-merge-gates`
- Corrective pull request: #32
- The accidental pull request #31 merge is not rewritten or force-pushed.
- Rollback: revert the three workflow changes and the policy module together; retain the lockfile and CodeQL fixes.

## Status

Validated; awaiting explicit approval to merge pull request #32.
