# Event-driven release pipeline

## Request

Apply the release separation validated in `fastypest` to `devbar`, excluding npm publication:

1. Evaluate the commit threshold after every default-branch push.
2. Create a version-only release pull request when the threshold is reached.
3. Validate and queue exact-head squash auto-merge after repository requirements pass.
4. Build and publish the macOS GitHub Release only when `package.json` changes version on the default branch.
5. Preserve manual recovery for the current version without creating releases for ordinary unchanged pushes.

No merge, GitHub Release, tag, installer publication, or deployment is part of this implementation delivery.

## Evidence

- `package.json` is `devbar@0.2.0`.
- `.github/workflows/auto-release.workflow.yml` is currently schedule-driven and directly requests auto-merge.
- `.github/workflows/release.yml` compares only `HEAD` and `HEAD~1`, which does not safely resolve multi-commit pushes or later same-version package metadata changes.
- The production installer boundary is `pnpm run release:mac`; it builds and verifies ARM64 and x64 DMG/ZIP files plus `SHA256SUMS.txt`.
- The repository uses an owner automation token so generated pull-request merges emit downstream push events.
- npm publication is not part of DevBar delivery.

## Scope

### In scope

- `.github/workflows/auto-release.workflow.yml`
- `.github/workflows/release-auto-merge.workflow.yml`
- `.github/workflows/release.yml`
- `.github/workflows/dependabot-auto-merge.workflow.yml`
- this task specification

### Out of scope

- application source, UI, packaging scripts, installer formats, signing, or notarization
- npm publication
- merging pull requests
- creating tags or GitHub Releases during implementation
- changing repository secrets, environments, or branch rules

## Decision

### Preparation

`.github/workflows/auto-release.workflow.yml` remains the preparation workflow but changes from a daily schedule to every default-branch push plus explicit manual dispatch. It:

- attaches to the exact event commit
- requires the current package version to have a matching stable GitHub Release and tag
- rejects release drift, wrong tag targets, missing baselines, and non-ancestor releases
- does nothing while a trusted release pull request is already open
- preserves the existing three-commit threshold and conventional-commit strategy
- runs frozen installation, repository quality checks, and the application packaging smoke build before versioning
- creates only `package.json` on `release/v<version>`
- creates an owner-authored, labeled pull request without merging or publishing

### Release pull-request trust

`.github/workflows/release-auto-merge.workflow.yml` is the sole owner of release pull-request validation. It runs from the trusted default-branch definition and never checks out or executes pull-request code. It validates:

- repository, owner author, base branch, `auto-release` label, exact `release/v<version>` branch, and exact title
- event and live head SHA equality
- stable and monotonic SemVer
- package identity and version
- exact changed file set: `package.json`
- absence of the destination tag and GitHub Release
- approval bound to the exact validated head

The owner automation token enables native expected-head squash auto-merge. Repository-required checks remain the merge authority, and the owner-token merge emits the downstream default-branch push.

### GitHub Release

`.github/workflows/release.yml` runs after every default-branch push and through exact-version manual recovery. It:

- exits successfully for ordinary pushes where `package.json` version did not change
- resolves the first-parent commit that introduced the current version, including multi-commit pushes
- checks out and builds the exact version-introducing commit
- runs the canonical `pnpm run release:mac` build and verifier
- creates an immutable tag only when absent
- creates generated GitHub Release notes with the exact five expected artifacts
- verifies release metadata, tag target, and exact asset membership
- treats an existing exact release as an idempotent success and rejects mismatched or incomplete existing state

There is no npm workflow or downstream publication stage.

### Dependabot

`.github/workflows/dependabot-auto-merge.workflow.yml` returns to Dependabot policy only. Patch and minor updates remain eligible; majors require manual QA. Release pull-request policy is not duplicated.

## Risks and controls

- **Privileged PR event:** the trusted release workflow never checks out or executes PR-controlled content.
- **Secret scope:** owner automation credentials are restricted to the protected `admin` environment and their authenticated identity is verified.
- **Stale events:** approval and auto-merge re-read the current head before acting.
- **Immediate native merge:** repository-required checks must remain configured; the workflow does not enumerate or weaken them.
- **Event suppression:** the owner token, not `GITHUB_TOKEN`, performs the generated release PR auto-merge.
- **Multi-commit push:** the release workflow locates the exact first-parent version-introducing commit rather than assuming `HEAD`.
- **Tag or release collision:** mismatched existing state fails closed; tags are never force-updated.
- **Artifact drift:** existing and newly created releases must contain exactly the four architecture-specific installers and checksum manifest.
- **Unsigned binaries:** existing signing and notarization limitations remain unchanged.

## Acceptance criteria

- Every default-branch push evaluates the three-commit threshold.
- Below threshold, no branch or PR is created.
- At threshold, preparation creates only a package version PR.
- The generated PR is approved and queued only after exact trust validation.
- Repository-required tests remain the authority for merge completion.
- A normal push without a version change cannot create a release.
- A version-changing push publishes installers from the exact version-introducing commit.
- Manual recovery uses the same release workflow and exact current version.
- No npm command publishes a package.
- No check polling, direct pre-test merge, force tag update, or destructive cleanup exists.

## Checks

- Parse all changed workflow YAML.
- Run `bash -n` over every changed shell block after neutralizing GitHub expressions.
- Run JavaScript syntax checks over `actions/github-script` programs.
- Verify every third-party Action reference is pinned to a full commit SHA.
- Assert preparation contains no tag push, GitHub Release creation, direct merge, or check polling.
- Assert release publication no-ops on unchanged package versions.
- Assert the release workflow uses the exact version-introducing commit and canonical `pnpm run release:mac` boundary.
- Assert no npm publication or npm authentication path exists.
- Assert no force push, tag mutation, or destructive failure cleanup exists.
- Run CI, release validation, and CodeQL on the final pull-request head.

## Rollback

Revert the implementation pull request. Existing tags, releases, installers, and release branches remain immutable evidence and are not deleted.

## Delivery

- Branch: `agent/refactor-event-driven-release`
- Pull request: pending
- Merge: requires explicit owner approval
- Release: not performed

## Status

Implementation in progress.
