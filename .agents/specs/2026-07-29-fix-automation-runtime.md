# Fix repository automation runtime

## Request

Audit the merged repository automation after real Dependabot executions, correct common failures and preserve the actor separation used by `fastypest` for dependency and release pull requests.

## Evidence

- The shared Dependabot workflow attempted repository-level label creation without an explicit repository and can fail because it intentionally performs no checkout.
- Eligible Dependabot pull requests were approved by `github-actions[bot]`, while the required contract is owner approval followed by GitHub Actions auto-merge.
- Release pull requests must be authored through the repository owner's token and approved by GitHub Actions; a workflow-created bot pull request cannot be approved by the same bot identity.
- `fastypest` uses `requires-manual-qa` color `E99695` and `auto-release` color `FEF2C0`.

## Decision

- Require `PAT_FINE` as a Dependabot repository secret for owner-authored dependency approvals.
- Require the same `PAT_FINE` as an Actions repository secret for the scheduled release workflow so its branch and pull request are authored by `juanjoGonDev`.
- The Actions token requires Contents, Issues and Pull requests read/write only for this repository; the Dependabot secret requires Pull requests read/write.
- Validate secrets inside shell steps rather than referencing secrets directly in `if:` expressions.
- Let `github.token` approve trusted owner-authored release pull requests and enable auto-merge.
- Add explicit repository context to `gh label create` and normalize label metadata.
- Keep the existing GitHub Release pipeline; do not add npm publication.
- Add fork guards and remove unused cache permissions.

## Acceptance criteria

- Eligible Dependabot updates are approved by `juanjoGonDev` and queued by GitHub Actions.
- Release pull requests are created by `juanjoGonDev`, carry `auto-release`, and are approved by `github-actions[bot]` for their exact head SHA.
- `requires-manual-qa` and `auto-release` have stable metadata.
- No untrusted pull-request code is checked out by privileged automation.
- Missing credentials fail with explicit setup guidance.

## Validation

- Workflow YAML parsed with a non-coercing loader.
- Actions remain pinned by immutable SHA.
- Pull-request CI validates formatting and repository checks.
- Full actor-identity validation requires both configured secret stores and subsequent Dependabot/release events.

## Rollback

Revert the corrective pull request. No release, package publication or deployment is performed by this branch.

## Delivery status

Implementation complete on `agent/fix-automation-runtime`; pull request and CI validation pending.
