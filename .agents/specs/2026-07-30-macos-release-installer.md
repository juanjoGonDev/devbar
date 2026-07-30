# macOS release installer repair

## Request

Restore automatic GitHub Releases after a trusted release pull request merges and publish macOS installers that users can download directly.

## Evidence

- Pull request #31 merged `package.json` version `0.2.0`, but no GitHub Release was created.
- The release pull request auto-merge was enabled with the repository `GITHUB_TOKEN`.
- GitHub suppresses most downstream workflow events caused by `GITHUB_TOKEN`, so the resulting push did not start the push-triggered release workflow.
- The existing release workflow produced only an ARM64 `.app` wrapped in ZIP, not a standard DMG installer.
- Required CI checks are now enforced on `main`, so GitHub native auto-merge can be retained safely.
- The repository already provides an owner-scoped fine-grained automation token through `REPOSITORY_AUTOMATION_TOKEN` or the `PAT_FINE` compatibility secret.
- Trial use of `electron-builder` `26.15.3` introduced six high-severity vulnerable transitive packages detected by `pnpm audit`; that dependency was rejected and removed.

## Decision

- Keep native GitHub squash auto-merge and required status checks.
- Enable release auto-merge with the owner-scoped automation token instead of `github.token`, preserving the downstream push event.
- Add a manual recovery path to the release workflow for a version already present in `package.json` but missing from GitHub Releases.
- Reuse the existing exact-pinned `electron-packager` dependency and native macOS `hdiutil`, `ditto`, `lipo`, and `shasum` tools.
- Generate separate Apple Silicon (`arm64`) and Intel (`x64`) DMG and ZIP artifacts plus SHA-256 checksums.
- Keep the current local `electron-packager` command for fast CI and local reinstall workflows.
- Publish unsigned and non-notarized artifacts until Apple Developer credentials are explicitly configured; document the Gatekeeper limitation.

## Acceptance criteria

- Release pull request auto-merge authenticates with the owner automation token and is bound to the exact head SHA.
- A version bump merged to `main` starts the release workflow.
- Manual dispatch can recover `v0.2.0` only when the requested version matches `package.json` and the release does not already exist.
- The release workflow creates architecture-specific DMG and ZIP files for `arm64` and `x64`, plus `SHA256SUMS.txt`.
- Each packaged executable matches its declared architecture.
- Both DMGs mount successfully and contain `DevBar.app` and an Applications link.
- Frozen installation, formatting, lint, dead-code analysis, dependency checks, tests, existing app packaging, dependency audit, and CodeQL pass.
- No GitHub Release is published and no pull request is merged without explicit approval.

## Dependency decision

- No new package is retained.
- `electron-builder` `26.15.3` was evaluated and rejected after `pnpm audit --audit-level=moderate` found six high-severity advisories in its transitive build-time graph.
- The selected implementation reuses `electron-packager` `17.1.2`, already exact-pinned and already exercised by repository CI.
- Native macOS tooling avoids a second packaging framework, dependency overrides, and vulnerable transitive packages.

## Validation plan

- Run `pnpm install --frozen-lockfile` against the unchanged dependency graph.
- Run `pnpm audit --audit-level=moderate`.
- Run Prettier, ESLint, Knip, dependency-cruiser, Vitest, and the existing `pnpm run pack` smoke build.
- Build both installers on `macos-15`.
- Inspect each executable with `lipo` and mount/unmount both DMGs with `hdiutil`.
- Validate the checksum manifest.
- Validate the final branch through pull-request CI and CodeQL.

## Delivery and rollback

- Branch: `agent/fix-macos-release-installer`.
- Pull request: #33.
- Rollback: revert the workflow, native packaging script, package script, README, and specification changes together.
- Recovery after merge: manually dispatch `Release` from `main` with version `0.2.0` to create the missing release.

## Status

Implemented; runtime validation pending.
