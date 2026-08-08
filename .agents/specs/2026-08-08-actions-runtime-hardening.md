# Actions runtime hardening

## Request

Correct the shared required-QA Dependabot merge automation after real rollout failures while preserving DevBar release triggering and repository security.

## Evidence

- The shared GraphQL auto-merge path fails when GitHub already reports an approved PR as `clean`.
- Refreshing a behind Dependabot PR that changes `.github/workflows/*` can require the sensitive Workflows permission.
- DevBar release automation is triggered by version changes merged to `main`; an immediate merge using `GITHUB_TOKEN` could suppress downstream workflow events.
- Repository instructions require every change to bump the application version and update `CHANGELOG.md`.

## Decision

- Preserve and revalidate exact-head, non-bot, write-maintainer QA approval.
- Use the protected `admin` Actions `PAT_FINE`, validated as the repository owner, for live branch/merge transitions so downstream workflows can run.
- Squash-merge an exact approved `clean` head; otherwise enable repository auto-merge when available.
- Never grant Workflows permission. Workflow-changing behind PRs require a trusted manual branch update and fresh approval.
- Keep dry-run non-mutating.
- Bump DevBar from `0.4.2` to `0.4.3` and document the fix in the Spanish changelog as required by `AGENTS.md`.

## Acceptance

Clean approved majors no longer fail; workflow-file refresh does not escalate permission; stale, bot, changed, conflicted or change-requested heads cannot merge; versioning and changelog stay aligned.

## Checks

Run `pnpm quality`, `pnpm format:check`/format validation, workflow syntax checks and pull-request CI.

## Rollback

Revert the corrective pull request. No merge or GitHub Release is performed by this branch.

## Delivery status

Implemented on `agent/fix-actions-runtime-20260808`; pending pull-request CI and explicit owner merge approval.
