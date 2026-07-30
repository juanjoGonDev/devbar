# DevBar release lockfile CI repair

## Request

Restore the failing CI for pull request #31 and ensure the trusted release pull request is automatically merged after all required checks pass.

## Evidence

- CI run `30531092681` failed in `pnpm install --frozen-lockfile`.
- pnpm reported `ERR_PNPM_BROKEN_LOCKFILE` because the snapshot key `fdir@6.5.0(picomatch@4.0.5)` appeared twice.
- The duplicate was introduced when the grouped Dependabot update changed the older `picomatch@4.0.4` snapshot to `4.0.5` while an existing `4.0.5` snapshot was already present.
- Both duplicated blocks were byte-for-byte identical; all consumers resolve to the remaining `fdir@6.5.0(picomatch@4.0.5)` snapshot.
- After the lockfile repair, CI run `30538688837` passed installation and then failed `prettier --check .` on `.github/workflows/codeql.yml`.
- The generated CodeQL workflow also used mutable action tags and persisted checkout credentials.
- Final CI and CodeQL runs passed, but pull request #31 remained open.
- `.github/workflows/auto-release.workflow.yml` attempts to queue auto-merge only once, immediately after creating the pull request.
- `.github/workflows/dependabot-auto-merge.workflow.yml` re-approves trusted release heads on every relevant pull-request event but did not enable auto-merge for release pull requests. Its successful runs therefore proved approval only, not merge queueing.

## Decision

- Remove exactly one of the two identical snapshot blocks.
- Keep frozen-lockfile enforcement and avoid regenerating unrelated dependency resolutions.
- Format the CodeQL workflow with the repository-pinned Prettier version, pin its actions to immutable SHAs, and disable persisted checkout credentials.
- Extend the trusted release pull-request job so every `opened`, `reopened`, `synchronize`, or `labeled` event both approves the exact current head and enables squash auto-merge for that same head.
- Keep the release eligibility checks: repository-owned actor, same-repository head, default target branch, non-fork repository, and `auto-release` label.
- Do not modify the intended release version or application behavior.

## Acceptance criteria

- `pnpm-lock.yaml` contains one `fdir@6.5.0(picomatch@4.0.5)` snapshot.
- `pnpm install --frozen-lockfile` succeeds.
- Existing lint, formatting, dead-code, dependency, test, package-build, and CodeQL checks remain enabled.
- CodeQL actions use immutable commit SHAs and checkout does not persist credentials.
- Trusted release pull requests enable squash auto-merge for the exact current head after approval.
- Non-release and untrusted pull requests cannot enter the release auto-merge path.
- The pull request contains no permanent elevated-permission repair automation.

## Validation

- A one-time branch-scoped workflow removed one duplicate and successfully ran `pnpm install --frozen-lockfile --ignore-scripts` before committing the lockfile.
- Temporary repair and formatting instrumentation was removed from the final diff.
- CI run `30539453638` passed frozen installation, lint, formatting, dead-code analysis, dependency architecture checks, tests, and application packaging.
- CodeQL run `30539453379` passed both the `actions` and `javascript-typescript` analyses.
- CI run `30539551598` and CodeQL run `30539551595` repeated the full green validation on the documented head.
- Auto-merge validation requires the final trusted release workflow run to enable the queue and GitHub to merge only after all required checks pass.

## Delivery

- Branch: `release/v0.2.0`
- Pull request: #31
- Rollback: revert the lockfile, CodeQL workflow, and release auto-merge repair commits independently if investigation requires restoring prior behavior.

## Status

Implemented; awaiting final auto-merge workflow and required checks.
