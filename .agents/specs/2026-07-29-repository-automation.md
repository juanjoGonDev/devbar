# Repository automation standardization

## Request

Audit the active GitHub Actions setup against `fastypest`, add generic cache maintenance, repository-specific Dependabot automation, and GitHub-only automatic release preparation. Open one PR without merging or releasing.

## Evidence

- Default branch: `main`.
- Stack: pnpm, Node.js, and Electron.
- Existing workflows: `ci.yml`, `release.yml`, and `version-bump.yml`.
- `release.yml` already builds `DevBar.app`, uploads `DevBar-macos-arm64.zip`, and generates GitHub release notes after a version bump.
- The reference cache pipeline is not empty-safe; the reference privileged workflow uses mutable Action tags and a PAT.

## Decision

- Add one cache-key-independent workflow using the repository cache API, bounded input validation, concurrent-delete handling, and manual dry-run by default.
- Group weekly npm and GitHub Actions updates after a seven-day cooldown.
- Auto-approve patch/minor updates and development-only majors without checking out PR code. Production majors require a current approval from a reviewer with repository write permission.
- Use immutable Action SHAs and read-only defaults. Write operations require `REPOSITORY_AUTOMATION_TOKEN`, with `PAT_FINE` as compatibility fallback.
- Add a scheduled Conventional-Commit release PR. Merging it delegates installer creation and generated release notes to the existing `release.yml`; npm publication is not added.

## Acceptance

- [x] No privileged workflow executes pull-request-controlled code.
- [x] Cache cleanup covers every repository Actions cache and handles empty/concurrent deletion safely.
- [x] Default branch lookup is dynamic.
- [x] Production majors cannot pass on an external or stale approval.
- [x] New third-party Actions are pinned by full SHA.
- [x] No merge, release, deployment, or publication is performed by this task.

## Validation

All proposed YAML parsed successfully with scalar-preserving YAML validation. Existing CI and release contracts were inspected. Pull-request checks remain the runtime gate.

## Risks and rollback

Auto-merge and branch protection must be configured consistently, and the automation token must have Contents, Issues, and Pull requests write access. Revert the workflow and Dependabot commits to roll back; no runtime data or artifacts require recovery.

## Delivery

- Branch: `agent/chore-repository-automation`
- Base: `main`
- Merge/release/deploy/publish: not authorized

## Status

Implemented on the task branch; pull-request CI and repository settings remain to be verified.
