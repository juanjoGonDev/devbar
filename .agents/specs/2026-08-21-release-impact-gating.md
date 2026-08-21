# Release artifact impact gating

## Request

Prevent DevBar from creating a version release and rebuilding macOS installers when the accumulated default-branch changes do not require a new application build. Maintenance-only changes such as README edits, tests, agent specifications, release workflow maintenance, and routine GitHub Actions pin updates must not trigger or count toward an automatic release.

Preserve explicit manual recovery and the existing immutable tag, exact release commit, installer verification, and GitHub Release contracts.

## Evidence

- `.github/workflows/auto-release.workflow.yml` previously counted every commit since the current release tag with `git rev-list --count`, so documentation and CI-only commits could satisfy the release threshold.
- Its automatic SemVer strategy scanned every commit message in the range, so a non-product `feat:` could incorrectly select a minor release.
- `.github/workflows/release.yml` treated any `package.json` version change as sufficient to build and publish four macOS installer assets plus `SHA256SUMS.txt`.
- Root `AGENTS.md` required a version bump for every change, including documentation and internal automation, which conflicted with impact-based release publication.
- The build boundary consumes application sources under `src/`, renderer inputs under `renderer/`, assets under `assets/`, dependency manifests/lockfile, TypeScript build configuration, and the macOS packaging/build scripts.
- CI enforces a repository-wide strict-TypeScript authored-source policy, so the release-impact owner must be `scripts/release-impact-policy.ts`, not a JavaScript-family file.
- Release validation exposed `GHSA-2v37-7h3g-55p8` through the pinned `nanoid@3.3.17` override. The override and lockfile were regenerated to patched `nanoid@3.3.18`; the audit gate was preserved rather than suppressed.

## Decision

Introduce `scripts/release-impact-policy.ts` as the single owner of release-impact classification and execute it directly with Node's TypeScript stripping support.

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

Root agent guidance is updated so release-neutral changes do not bump `package.json` or `CHANGELOG.md`; release-impacting user/product changes retain semantic versioning and human changelog requirements. The `nanoid` remediation is a dependency-security change discovered by validation and therefore remains visible to the conservative dependency-impact policy; this PR does not directly prepare a version, leaving threshold-based version preparation to the trusted auto-release workflow.

## Acceptance criteria

- README-only, test-only, spec-only, and GitHub Actions/workflow-only changes do not count toward the automatic release threshold.
- A `package.json` change that only changes `version` is not release-impacting by itself.
- Product source, renderer, asset, dependency, build-config, or packaging changes are release-impacting.
- Mixed changes are release-impacting when any canonical build input changes.
- Automatic release strategy ignores non-impacting commit messages.
- A version-changing merge with no pending release-impacting commits exits successfully without building or publishing installers.
- A version-changing merge with pending release-impacting commits preserves exact-commit build, immutable tag, asset verification, and GitHub Release behavior.
- Manual recovery remains available for the exact current version.
- The impact rule exists in one strict-TypeScript script and is covered by deterministic tests.
- Repository-authored JavaScript-family files remain forbidden.
- `pnpm audit --audit-level=moderate` remains enforced and the known `nanoid` high-severity advisory is patched rather than ignored.
- No merge, tag, GitHub Release, or installer publication is performed by this delivery.

## Checks

- `pnpm format:check`
- `pnpm quality`
- policy regression tests
- workflow contract tests
- `pnpm audit --audit-level=moderate`
- PR CI and release-validation checks
- CodeQL

## Risks

- **False negative:** missing a real build input could delay a release. The allowlist is derived from the current build/package scripts and is regression-tested.
- **False positive:** an overly broad path would still waste macOS build budget. Verification-only and workflow-only paths are intentionally excluded from publication impact.
- **Dependency conservatism:** semantic dependency/lockfile changes are treated as release-impacting even when validation discovers them through dev tooling; this favors correctness over silently missing a shipped dependency change.
- **Version drift from legacy automation:** an old maintenance-only version bump may create a skipped version. Future guidance prevents this; manual recovery remains explicit.
- **History topology:** first-parent counting represents changes that actually landed on the protected default branch and avoids counting internal PR commits multiple times.

## Rollback

Revert the implementation PR. Existing tags, releases, and installers are never mutated or deleted.

## Delivery

- Branch: `fix/release-impact-gating`
- Pull request: `#54`
- Merge: owner decision
- Release/tag/installer publication: not part of this delivery

## Status

Implementation complete; final PR validation in progress.
