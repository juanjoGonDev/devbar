# Release-impact gating

## Request

Prevent routine maintenance commits from accumulating toward DevBar's automatic release threshold while preserving releases for changes that can alter the packaged macOS application or substantive release behavior. Analyze DevBar's installer pipeline rather than applying a container policy.

## Evidence

- DevBar publishes macOS DMG/ZIP assets, not GHCR images.
- `.github/workflows/release.yml` already publishes only when `package.json.version` changes.
- `.github/workflows/auto-release.workflow.yml` currently counts every commit since the latest release tag toward `MINIMUM_COMMITS=3`, so Actions-only maintenance can eventually cause a release PR even though it cannot change the app.
- `scripts/build.sh` builds from `src/**`, `renderer/**`, TypeScript build configuration and `assets/**`.
- `scripts/package-macos-app.sh`, `scripts/package-electron.ts`, `scripts/build-macos-release.sh`, and `scripts/verify-macos-release.sh` own packaging/release artifacts.
- `package.json` and `pnpm-lock.yaml` affect Electron, packager, esbuild, runtime dependencies and therefore can alter produced installers. Production and build dependency updates remain release-impacting.
- Routine GitHub Actions dependency PRs update workflow `uses:` pins and must not count as app-release changes by themselves.

## Decision

Add one dependency-free `scripts/release-impact-policy.mjs` as the source of truth for whether a commit can affect a DevBar release artifact or substantive release behavior.

Artifact-impacting paths:

- `src/**`
- `renderer/**`
- `assets/**`
- `package.json`
- `pnpm-lock.yaml`
- `.npmrc`
- `tsconfig.base.json`
- `tsconfig.node.json`
- `tsconfig.renderer.json`
- `scripts/build.sh`
- `scripts/package-electron.ts`
- `scripts/package-macos-app.sh`
- `scripts/build-macos-release.sh`
- `scripts/verify-macos-release.sh`

Substantive release-automation changes to `release.yml` or `auto-release.workflow.yml` are release-impacting. A workflow diff is mechanical maintenance only when every changed content line is a `uses:` declaration. The decision never relies on Dependabot identity, PR title, labels or commit messages.

`auto-release.workflow.yml` will count only release-impacting first-parent commits since the current release tag. Version strategy is derived only from those impacting commits. Non-impacting maintenance commits remain in history but do not advance the automatic release threshold.

`release.yml` remains version-owned: a version-changing merge still publishes the exact version-introducing commit and existing installer validation stays unchanged.

## Acceptance

- Actions-only `uses:` updates do not increment the automatic release commit count;
- docs/tests/specs/CI/tooling-only commits do not increment it unless they substantively change release automation;
- source/renderer/assets changes increment it;
- package/lock dependency updates increment it, including Electron/esbuild/packager/runtime dependencies;
- packaging scripts and TypeScript build configuration increment it;
- substantive release workflow edits increment it;
- mixed commits increment once when any impacting change exists;
- release strategy ignores non-impacting commit messages and considers only impacting commits;
- existing version-change release workflow, exact release commit resolution and macOS installer verification are preserved;
- canonical `pnpm quality`, format check and CI pass;
- no merge, release or publication is performed by this task.

## Tests

- table-driven RUN/SKIP path coverage;
- mechanical `uses:` workflow diff -> SKIP;
- substantive release workflow diff -> RUN;
- mixed Actions update + app source -> RUN;
- workflow contract proving the automatic release threshold counts policy-approved commits rather than `git rev-list --count` over all commits;
- workflow contract proving strategy uses only impacting commit SHAs;
- dependency update fixtures remain RUN.

## Risks

- Path policy can drift from packaging inputs. Tests must pin current build/package owners.
- A broad Actions exception could hide release-logic changes. Only `uses:` content-line replacements qualify as mechanical maintenance.
- The current repository convention requires version bumps for authored changes. This task does not change that convention; it fixes automatic threshold accounting for commits such as Dependabot maintenance that do not introduce an app version themselves.

## Rollback

Revert the helper/tests/workflow/spec. No persisted application state or installer format migration is involved.

## Delivery

Branch: `fix/release-impact-gate`.

Open a non-draft PR to `main`. Do not merge or publish a release.

## Status

Recon and decision complete. Implementation and validation pending.
