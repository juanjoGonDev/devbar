# Release artifact impact gating

## Request

Prevent DevBar from creating a version release and rebuilding macOS installers when the accumulated default-branch changes do not require a new application build. Maintenance-only changes such as README edits, tests, agent specifications, release workflow maintenance, and routine GitHub Actions pin updates must not trigger or count toward an automatic release.

Preserve explicit manual recovery and the existing immutable tag, exact release commit, installer verification, and GitHub Release contracts.

## Evidence

- `.github/workflows/auto-release.workflow.yml` currently counts every commit since the current release tag with `git rev-list --count`, so documentation and CI-only commits can satisfy the release threshold.
- Its automatic SemVer strategy scans every commit message in the range, so a non-product `feat:` can incorrectly select a minor release.
- `.github/workflows/release.yml` currently treats any `package.json` version change as sufficient to build and publish four macOS installer assets plus `SHA256SUMS.txt`.
- Root `AGENTS.md` currently requires a version bump for every change, including documentation and internal automation, which directly conflicts with impact-based release publication.
- The build boundary consumes application sources under `src/`, renderer inputs under `renderer/`, assets under `assets/`, dependency manifests/lockfile, TypeScript build configuration, and the macOS packaging/build scripts.

## Decision

Introduce `scripts/release-impact-policy.mjs` as the single owner of release-impact classification.

A change is release-impacting when it can alter the shipped application or installer build inputs:

- `src/**`
- `renderer/**`
- `assets/**`
- semantic `package.json` changes other than `version` alone
- `pnpm-lock.yaml`
- `.npmrc`
- `tsconfig.node.json`
- `tsconfig.renderer.json`
- `scripts/build.sh`
- `scripts/build-macos-release.sh`
- `scripts/package-electron.ts`
- `scripts/package-macos-app.sh`

Documentation, tests, agent specs, ordinary workflow maintenance, release-policy code, verification-only scripts, and a version-only `package.json` edit do not independently require a new build.

The policy evaluates real Git diffs. For automatic release preparation it counts only release-impacting first-parent commits since the current release tag. Automatic SemVer strategy is derived only from those impactful commit messages. Manual `force` continues to override the threshold.

The publication workflow verifies that a version-introducing commit has at least one release-impacting commit since the latest stable release before building installers. `workflow_dispatch` remains an explicit recovery path and is not suppressed by automatic impact gating.

Root agent guidance is updated so release-neutral changes do not bump `package.json` or `CHANGELOG.md`; release-impacting user/product changes retain semantic versioning and human changelog requirements.

## Acceptance criteria

- README-only, test-only, spec-only, and GitHub Actions/workflow-only changes do not count toward the automatic release threshold.
- A `package.json` change that only changes `version` is not release-impacting by itself.
- Product source, renderer, asset, dependency, build-config, or packaging changes are release-impacting.
- Mixed changes are release-impacting when any canonical build input changes.
- Automatic release strategy ignores non-impacting commit messages.
- A version-changing merge with no pending release-impacting commits exits successfully without building or publishing installers.
- A version-changing merge with pending release-impacting commits preserves exact-commit build, immutable tag, asset verification, and GitHub Release behavior.
- Manual recovery remains available for the exact current version.
- The impact rule exists in one script and is covered by deterministic tests.
- This implementation PR does not bump the application version because it changes release infrastructure rather than shipped application inputs.

## Checks

- `pnpm format:check`
- `pnpm quality`
- policy regression tests
- workflow contract tests
- PR CI and release-validation checks

## Risks

- **False negative:** missing a real build input could delay a release. The allowlist is derived from the current build/package scripts and is regression-tested.
- **False positive:** an overly broad path would still waste macOS build budget. Verification-only and workflow-only paths are intentionally excluded from publication impact.
- **Version drift from legacy automation:** an old maintenance-only version bump may create a skipped version. Future guidance prevents this; manual recovery remains explicit.
- **History topology:** first-parent counting represents changes that actually landed on the protected default branch and avoids counting internal PR commits multiple times.

## Rollback

Revert the implementation PR. Existing tags, releases, and installers are never mutated or deleted.

## Delivery

- Branch: `fix/release-impact-gating`
- Merge: owner decision
- Release/tag/installer publication: not part of this delivery

## Status

Implementation in progress.
