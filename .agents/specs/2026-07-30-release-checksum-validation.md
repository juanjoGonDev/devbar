# Release checksum validation regression

## Request

Repair failed Release run `30551549616`, prevent the same checksum-path defect from recurring, and validate the complete macOS release artifact pipeline without publishing a real GitHub Release.

## Evidence

- Run `30551549616`, job `90901250637`, built all ARM64 and x64 DMG and ZIP artifacts successfully.
- `scripts/build-macos-release.sh` generates `SHA256SUMS.txt` from inside `dist/release`, so every manifest entry is relative to that directory.
- `.github/workflows/release.yml` invoked `shasum --check dist/release/SHA256SUMS.txt` from the repository root.
- `shasum` therefore resolved each manifest filename against the repository root and reported all four generated artifacts as missing.
- The publication step was skipped, so no partial GitHub Release or tag was created.

## Decision

- Replace the workflow-local checksum command with a repository-owned artifact verification contract.
- Verify artifact existence, exact manifest membership, safe manifest paths, and SHA-256 contents through Node.js so verification is independent of the caller working directory.
- Add a macOS verifier that reuses the checksum contract and additionally checks ZIP integrity, DMG integrity and mounting, executable architecture, Applications link, icon, and `Info.plist`.
- Expose one `release:mac` command that builds and verifies the installers.
- Use the exact same `release:mac` command in the publishing workflow and in a non-publishing pull-request workflow.
- Keep GitHub Release creation as the only privileged step; the dry run receives read-only repository permissions and never creates tags or releases.

## Acceptance criteria

- Running the artifact verifier from a directory other than the repository root succeeds for a valid artifact set.
- Missing, altered, duplicate, unexpected, or path-traversing manifest entries fail closed.
- `release:mac` builds and verifies ARM64 and x64 DMG and ZIP artifacts plus `SHA256SUMS.txt` on `macos-15`.
- Both DMGs pass `hdiutil verify`, mount read-only, contain `DevBar.app`, and expose an `/Applications` link.
- The mounted executables report the expected `arm64` and `x86_64` Mach-O architectures.
- Both ZIP archives pass integrity checks and contain the DevBar executable.
- The app icon and `CFBundleIconFile` remain correct in both bundles.
- Pull-request CI, CodeQL, and the non-publishing Release validation workflow pass on the final head.
- No release, tag, merge, or deployment occurs as part of validation.

## Test plan

- Add Vitest coverage for expected artifact names, valid manifests, unsafe paths, duplicate entries, tampered artifacts, and caller working-directory independence.
- Run the full existing test and quality suite through CI.
- Run the new release validation workflow on `macos-15` using frozen installation, dependency audit, regression tests, and the exact `pnpm run release:mac` command used by production publication.
- Upload only checksum and release-plan evidence with short retention; do not upload or publish release assets externally.

## Risks

- macOS validation adds runner cost when release-related files change, but it is path-filtered and runs in parallel with normal CI.
- Public release assets remain unsigned and non-notarized; this change does not add Apple credentials or alter that documented behavior.
- A GitHub service or permission failure during the final `gh release create` call cannot be proven without performing the publication, but every deterministic build and validation input is exercised before that privileged boundary.

## Rollback

Revert the artifact verifier, macOS verifier, package scripts, release workflow change, release validation workflow, regression tests, and this specification together.

## Delivery

- Branch: `agent/fix-release-checksum-validation`.
- Pull request: pending.
- Failed release recovery after merge: manually rerun Release for version `0.2.0` only after the corrected dry run and required checks are green.

## Status

Implemented; validation pending.
