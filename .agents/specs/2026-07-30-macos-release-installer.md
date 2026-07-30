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
- The previous deprecated `electron-packager` graph, ESLint 9 graph, and `electron-store` transitive graph contained five additional high-severity advisories.

## Decision

- Keep native GitHub squash auto-merge and required status checks.
- Enable release auto-merge with the owner-scoped automation token instead of `github.token`, preserving the downstream push event.
- Add a manual recovery path to the release workflow for a version already present in `package.json` but missing from GitHub Releases.
- Replace deprecated `electron-packager` `17.1.2` with official `@electron/packager` `20.0.3` and invoke its public API through a dedicated packaging boundary.
- Upgrade ESLint to exact version `10.7.0`, raise the Node requirement to `>=22.13.0`, and pin compatible patched `fast-uri` and `js-yaml` transitives.
- Use native macOS `hdiutil`, `ditto`, `lipo`, `PlistBuddy`, and `shasum` tools for installer construction and verification.
- Generate separate Apple Silicon (`arm64`) and Intel (`x64`) DMG and ZIP artifacts plus SHA-256 checksums.
- Copy the project `icon.icns` into every app bundle and set `CFBundleIconFile` explicitly before producing release artifacts.
- Publish unsigned and non-notarized artifacts until Apple Developer credentials are explicitly configured; document the Gatekeeper limitation.

## Acceptance criteria

- Release pull request auto-merge authenticates with the owner automation token and is bound to the exact head SHA.
- A version bump merged to `main` starts the release workflow.
- Manual dispatch can recover `v0.2.0` only when the requested version matches `package.json` and the release does not already exist.
- The release workflow creates architecture-specific DMG and ZIP files for `arm64` and `x64`, plus `SHA256SUMS.txt`.
- Each packaged executable matches its declared architecture.
- Every app bundle contains the intended icon and references it through `CFBundleIconFile`.
- Both DMGs mount successfully and contain `DevBar.app` and an Applications link.
- Frozen installation, formatting, lint, dead-code analysis, dependency checks, 353 tests, existing app packaging, dependency audit, and CodeQL pass.
- No GitHub Release is published and no pull request is merged without explicit approval.

## Dependency decision

- Retained package: official `@electron/packager` `20.0.3`, exact-pinned.
- Removed package: deprecated `electron-packager` `17.1.2`.
- Rejected package: `electron-builder` `26.15.3`, because its tested transitive graph introduced six high-severity advisories.
- ESLint was upgraded from `9.39.4` to exact `10.7.0`; the flat configuration remained compatible.
- Exact pnpm overrides select patched `fast-uri` `3.1.4` and `js-yaml` `4.3.0` releases compatible with their consumers.
- `pnpm audit --audit-level=moderate` reports no known vulnerabilities on the final dependency graph.

## Validation

- CI run `30550018823` completed the permanent Linux job successfully: frozen install, ESLint, Prettier, Knip, dependency-cruiser, 353 Vitest tests, and the app packaging smoke test.
- The same run completed the macOS validation job successfully on `macos-15`.
- The macOS job passed dependency audit, quality checks, and the existing packaging smoke build.
- It built ARM64 and x64 DMG and ZIP artifacts, mounted both DMGs, validated their Applications links, confirmed Mach-O architectures, checked the app icon and `Info.plist`, and verified `SHA256SUMS.txt`.
- The branch-specific validation and lockfile-finalization jobs are removed from the permanent CI workflow after this evidence is captured.
- Final pull-request CI and CodeQL must pass again after restoring the permanent workflow.

## Delivery and rollback

- Branch: `agent/fix-macos-release-installer`.
- Pull request: #33.
- Rollback: revert the release workflows, packaging boundaries, dependency graph, README, and specification changes together.
- Recovery after merge: manually dispatch `Release` from `main` with version `0.2.0` to create the missing release.

## Status

Validated; awaiting review and merge.
