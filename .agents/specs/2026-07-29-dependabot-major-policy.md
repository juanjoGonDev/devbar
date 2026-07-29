# Dependabot major update policy

## Status

In progress.

## Request

Prevent every semantic-version major Dependabot update from being approved or queued automatically. Patch and minor updates may retain the existing owner-approval and expected-head auto-merge flow.

## Evidence

The current workflow marks development-only major updates as eligible. Tooling and runtime majors such as Electron, ESLint, dependency-cruiser and GitHub Actions can require migrations or break CI despite being development dependencies.

## Decision

Classify only patch and minor updates as eligible. Classify every major update as requiring manual QA, independent of dependency type. Keep the existing actor separation: the owner PAT approves eligible updates and `github-actions[bot]` queues expected-head squash auto-merge.

## Acceptance criteria

- Patch and minor updates remain eligible.
- Every major update receives `requires-manual-qa` and is not auto-approved or queued.
- Unknown update types are ignored safely.
- The classification step exercises patch, minor, major and unknown contract cases before processing the event.
- Workflow permissions remain least-privilege.

## Validation

Pending workflow syntax review, pull-request checks and runtime evidence from the next Dependabot event.

## Delivery

Branch: `agent/fix-dependabot-major-policy`.

## Rollback

Revert the workflow and this specification.
