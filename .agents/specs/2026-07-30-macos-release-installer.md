# macOS release installer repair

## Request

Restore automatic GitHub Releases after a trusted release pull request merges and publish a macOS installer that users can download directly.

## Evidence

- Pull request #31 merged `package.json` version `0.2.0`, but no GitHub Release was created.
- The release pull request auto-merge was enabled with the repository `GITHUB_TOKEN`.
- GitHub suppresses most downstream workflow events caused by `GITHUB_TOKEN`, so the resulting push did not start the push-triggered release workflow.
- The existing release workflow produced only an ARM64 `.app` wrapped in ZIP, not a standard DMG installer.
- Required CI checks are now enforced on `main`, so GitHub native auto-merge can be retained safely.
- The repository already provides an owner-scoped fine-grained automation token through `REPOSITORY_AUTOMATION_TOKEN` or the `PAT_FINE` compatibility secret.

## Decision

- Keep native GitHub squash auto-merge and required status checks.
- Enable release auto-merge with the owner-scoped automation token instead of `github.token`, preserving the downstream push event.
- Add a manual recovery path to the release workflow for a version already present in `package.json` but missing from GitHub Releases.
- Replace the release artifact build with `electron-builder` `26.15.3`, pinned exactly after its release cooldown.
- Generate universal Intel and Apple Silicon DMG and ZIP artifacts plus SHA-256 checksums.
- Keep the current local `electron-packager` command for fast CI and local reinstall workflows.
- Publish unsigned and non-notarized artifacts until Apple Developer credentials are explicitly configured; document the Gatekeeper limitation.

## Acceptance criteria

- Release pull request auto-merge authenticates with the owner automation token and is bound to the exact head SHA.
- A version bump merged to `main` starts the release workflow.
- Manual dispatch can recover `v0.2.0` only when the requested version matches `package.json` and the release does not already exist.
- The release workflow creates `DevBar-<version>-universal.dmg`, `DevBar-<version>-universal.zip`, and `SHA256SUMS.txt`.
- The packaged executable contains both `x86_64` and `arm64` slices.
- The DMG mounts successfully and contains `DevBar.app`.
- Frozen installation, formatting, lint, dead-code analysis, dependency checks, tests, existing app packaging, dependency audit, and CodeQL pass.
- No GitHub Release is published and no pull request is merged without explicit approval.

## Dependency review

- Package: `electron-builder`.
- Version: `26.15.3`, exact pin.
- Publisher/project: electron-userland/electron-builder.
- License: MIT.
- Purpose: canonical Electron packaging tool supporting DMG, ZIP, universal macOS builds, signing, notarization, and GitHub Releases.
- Alternatives rejected: retaining `electron-packager` plus custom `hdiutil` would duplicate packaging, architecture merging, artifact naming, and future signing/notarization behavior.
- Build scripts remain blocked by pnpm unless already allow-listed; no new package is added to `pnpm.onlyBuiltDependencies`.

## Validation plan

- Generate `pnpm-lock.yaml` with pnpm `10.32.1` and blocked dependency scripts.
- Run `pnpm install --frozen-lockfile`.
- Run Prettier, ESLint, Knip, dependency-cruiser, Vitest, and the existing `pnpm run pack` smoke build.
- Run `pnpm audit --audit-level=moderate`.
- Build the universal installer on `macos-15` with signing discovery disabled.
- Inspect the executable with `lipo` and mount/unmount the DMG with `hdiutil`.
- Validate the final branch through pull-request CI and CodeQL.

## Delivery and rollback

- Branch: `agent/fix-macos-release-installer`.
- Rollback: revert the workflow, builder configuration, dependency, lockfile, and documentation changes together.
- Recovery after merge: manually dispatch `Release` from `main` with version `0.2.0` to create the missing release.

## Status

Implemented; runtime validation pending.
