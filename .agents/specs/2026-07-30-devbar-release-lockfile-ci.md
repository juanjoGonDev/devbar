# DevBar release lockfile CI repair

## Request

Restore the failing CI for pull request #31 without changing the intended v0.2.0 release contents.

## Evidence

- CI run `30531092681` failed in `pnpm install --frozen-lockfile`.
- pnpm reported `ERR_PNPM_BROKEN_LOCKFILE` because the snapshot key `fdir@6.5.0(picomatch@4.0.5)` appeared twice.
- The duplicate was introduced when the grouped Dependabot update changed the older `picomatch@4.0.4` snapshot to `4.0.5` while an existing `4.0.5` snapshot was already present.
- Both duplicated blocks were byte-for-byte identical; all consumers resolve to the remaining `fdir@6.5.0(picomatch@4.0.5)` snapshot.
- After the lockfile repair, CI run `30538688837` passed installation and then failed `prettier --check .` on `.github/workflows/codeql.yml`.
- The generated CodeQL workflow also used mutable action tags and persisted checkout credentials.

## Decision

- Remove exactly one of the two identical snapshot blocks.
- Keep frozen-lockfile enforcement and avoid regenerating unrelated dependency resolutions.
- Format the CodeQL workflow, pin its actions to the exact SHAs resolved by the successful CodeQL run, and disable persisted checkout credentials.
- Do not modify the intended release version or application behavior.

## Acceptance criteria

- `pnpm-lock.yaml` contains one `fdir@6.5.0(picomatch@4.0.5)` snapshot.
- `pnpm install --frozen-lockfile` succeeds.
- Existing lint, formatting, dead-code, dependency, test, package-build, and CodeQL checks remain enabled.
- CodeQL actions use immutable commit SHAs and checkout does not persist credentials.
- The pull request contains no permanent elevated-permission repair automation.

## Validation

- A one-time branch-scoped workflow removed one duplicate and successfully ran `pnpm install --frozen-lockfile --ignore-scripts` before committing the lockfile.
- The temporary workflow was removed immediately after the validated repair.
- The normal CI subsequently confirmed the frozen install succeeds and exposed the independent CodeQL workflow formatting failure.
- Final validation is the normal pull-request CI and CodeQL suite on the resulting branch head.

## Delivery

- Branch: `release/v0.2.0`
- Pull request: #31
- Rollback: revert the lockfile and CodeQL workflow repair commits independently if investigation requires restoring either prior state.

## Status

Implemented; awaiting final GitHub Actions completion.
