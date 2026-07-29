# Repository automation standardization

## Request

Audit the active GitHub Actions setup against `fastypest`, add generic cache maintenance, repository-specific Dependabot automation, and GitHub-only automatic release preparation. Open one PR without merging or releasing.

## Evidence

- Default branch: `main`.
- Stack: pnpm, Node.js, and Electron.
- Existing workflows: `ci.yml`, `release.yml`, and `version-bump.yml`.
- `release.yml` already builds `DevBar.app`, uploads `DevBar-macos-arm64.zip`, and generates GitHub release notes after a version bump.
- Dependabot-triggered `pull_request_target` workflows receive a read-only token and no secrets, so privileged Dependabot automation must not depend on repository secrets.
- Release PRs created with the built-in `GITHUB_TOKEN` would not trigger the downstream CI/release workflow chain; the release preparer therefore needs an external automation credential.

## Decision

- Add one cache-key-independent workflow using the repository cache API, bounded input validation, concurrent-delete handling, and manual dry-run by default.
- Group weekly npm and GitHub Actions updates after a seven-day cooldown while preserving exact dependency versions.
- Use `pull_request` plus the repository-scoped `GITHUB_TOKEN` for Dependabot approval, labels, and auto-merge; no PR code is checked out.
- Require a current write-permission maintainer approval for production majors, bound to the current head SHA.
- Use the scheduled default-branch workflow and `GITHUB_TOKEN` for required-QA branch updates and auto-merge.
- Add a scheduled Conventional-Commit release PR. Merging it delegates installer creation and generated release notes to the existing `release.yml`; npm publication is not added.
- Restrict the external credential to the release PR workflow only.

## Acceptance

- [x] No privileged workflow checks out pull-request-controlled code.
- [x] Cache cleanup covers every repository Actions cache and handles empty/concurrent deletion safely.
- [x] Default branch lookup is dynamic.
- [x] Production majors cannot pass on an external or stale approval.
- [x] Dependabot and required-QA automation require no repository secret or variable.
- [x] Only GitHub-only release preparation requires an external automation secret.
- [x] New third-party Actions are pinned by full SHA.
- [x] No merge, release, deployment, or publication is performed by this task.

## Validation

All proposed YAML parsed successfully with scalar-preserving YAML validation. Existing CI and release contracts were inspected. Pull-request checks remain the runtime gate.

## Repository settings

Enable repository auto-merge and `Allow GitHub Actions to create and approve pull requests`. Required status checks must remain enforced on `main`.

## Release secret

Configure the Actions secret `REPOSITORY_AUTOMATION_TOKEN` for `auto-release.workflow.yml`. `PAT_FINE` remains a compatibility fallback. Use a fine-grained token limited to `devbar` with Contents and Pull requests read/write permissions.

## Risks and rollback

The release workflow cannot create a PR without the external token. Dependabot approval and auto-merge cannot operate if the repository settings above are disabled. Revert this PR to roll back; no runtime data or artifacts require recovery.

## Delivery

- Branch: `agent/chore-repository-automation`
- Base: `main`
- Merge/release/deploy/publish: not authorized

## Status

Implemented on the task branch; pull-request checks and repository settings remain to be verified.
