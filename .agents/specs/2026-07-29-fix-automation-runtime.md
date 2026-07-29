# Fix repository automation runtime

## Request

Audit the merged repository automation after real Dependabot executions, correct common failures, create the required labels and preserve the actor separation used by `fastypest` for dependency and release pull requests.

## Evidence

- Repository-level label creation can fail in no-checkout jobs without explicit repository context.
- Eligible Dependabot pull requests were approved by `github-actions[bot]`, while the required contract is owner approval followed by GitHub Actions auto-merge.
- Release pull requests must be authored through the repository owner's token and approved by GitHub Actions; a bot-authored PR cannot be approved by the same bot identity.
- Automated review identified missing actor verification, missing approval-setting guidance, dry-run label mutation and a concurrent label-creation race.
- `fastypest` uses `requires-manual-qa` color `E99695` and `auto-release` color `FEF2C0`.

## Decision

- Require `PAT_FINE` as a Dependabot repository secret with Pull requests read/write.
- Require `PAT_FINE` as an Actions repository secret with Contents, Issues and Pull requests read/write so release branches and PRs are authored by `juanjoGonDev`.
- Resolve every PAT-authenticated actor with `gh api user` and fail unless it equals `GITHUB_REPOSITORY_OWNER`.
- Let `github.token` approve only trusted owner-authored release pull requests for their exact head SHA and enable auto-merge.
- Surface a precise 403 error when **Allow GitHub Actions to create and approve pull requests** is disabled.
- Require repository settings **Allow auto-merge** and **Allow GitHub Actions to create and approve pull requests**.
- Synchronize `requires-manual-qa` and `auto-release` outside dry-run mode, tolerate only the specific concurrent `422 already_exists` race and adapt the release description to GitHub Releases.
- Keep the existing macOS GitHub Release pipeline; do not add npm publication.
- Add fork guards, explicit repository context and minimum cache permissions.

## Acceptance criteria

- Eligible Dependabot updates are approved by `juanjoGonDev`, never by a bot or another PAT owner.
- Release PRs are created by `juanjoGonDev`, carry `auto-release`, and are approved by `github-actions[bot]` for the exact current head.
- GitHub Actions queues squash auto-merge after required checks.
- Production majors remain manual and require a current non-bot write maintainer approval.
- Manual dry runs make no repository mutation and concurrent label creation cannot abort processing.
- Missing, incorrectly owned or insufficient credentials fail with precise setup guidance.

## Validation

- Workflow YAML and formatting are validated by repository CI; changed Actions remain pinned by immutable SHA.
- The temporary formatting workflow and its artifact were removed after applying the exact repository Prettier output.
- Runtime actor validation requires both secret stores and subsequent Dependabot/release events after merge.

## Rollback

Revert the corrective pull request. No release, package publication, deployment or merge is performed by this branch.

## Delivery status

Implemented on `agent/fix-automation-runtime` and delivered through a normal corrective pull request. No merge or release is included.
