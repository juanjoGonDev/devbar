# AGENTS.md — working agreements for AI agents on DevBar

Conventions an agent MUST follow when changing this repo. Human-facing docs
live in `README.md`; user-facing release notes live in `CHANGELOG.md`.

## Versioning (MANDATORY for release-impacting changes)

`scripts/release-impact-policy.ts` is the single source of truth for whether a
change requires a new application build/release.

Release-impacting product/build changes bump the version. Release-neutral
changes MUST NOT bump `package.json` or add a `CHANGELOG.md` entry solely to
satisfy process. Release-neutral examples include README/docs, tests, agent
specifications, workflow/release-infrastructure maintenance, and routine GitHub
Actions pin updates.

For release-impacting changes, follow semantic versioning:

- **patch** (`0.0.X`) — bug fixes and backwards-compatible product fixes.
- **minor** (`0.X.0`) — new user-facing functionality (backwards compatible).
- **major** (`X.0.0`) — breaking changes.

Rules:

1. Before changing version metadata, evaluate the change against
   `scripts/release-impact-policy.ts`; do not duplicate the path policy.
2. For a release-impacting change that is versioned directly, bump `version` in
   `package.json` in the same change. The trusted auto-release workflow may also
   prepare version-only release PRs after its release-impacting commit threshold.
3. When a change mixes fixes and new features, the **feature** wins → bump minor.
4. For a release-impacting user/product change, add a matching entry to
   `CHANGELOG.md` (Keep a Changelog format, Spanish), written for humans.
5. Release notes are produced by `.github/workflows/release.yml` via
   `gh release create --generate-notes` (i.e. from merged PR titles), **not**
   from `CHANGELOG.md`. So for the in-app changelog to read well, the PR title
   must be descriptive, or the PR/release body must carry the `CHANGELOG.md`
   section. Keep `CHANGELOG.md` as the canonical hand-written product record.
6. Do not hand-create git tags or GitHub releases — a trusted version-changing
   commit with pending release impact triggers the release pipeline. Explicit
   `workflow_dispatch` remains the recovery path.

## Branches & commits (feed the release notes)

Because release notes are generated from merged PR titles / commit messages
(see the Versioning section), the branch name and commit message are not
throwaway — they end up in the public project history. So:

1. Never work on `main`. Create a descriptive branch first, kebab-case, prefixed
   by intent: `fix/…`, `feat/…`, `refactor/…`, `docs/…`
   (e.g. `fix/branch-selector-shrink`).
2. Use Conventional Commits, written for a human reading release notes — not a
   diff summary (e.g. `fix: keep the bar from shrinking when the branch selector
opens`). No AI attribution / `Co-Authored-By` lines.
3. The commit subject and PR title must describe the meaningful change. For
   release-impacting work, generated notes and the hand-written `CHANGELOG.md`
   entry should tell the same story.
4. **Commits and PRs (title + body) are always written in English**, regardless
   of the language of the conversation — they are the shared, public history of
   the repo. `CHANGELOG.md` is the exception: it stays in Spanish because it is
   the user-facing product record.

## Test layout (enforced by ESLint, not advisory)

`eslint.config.ts` runs `@vitest/eslint-plugin` over `tests/**/*.test.ts`, so a
test that breaks one of these fails `pnpm lint:strict` — a gate, not a
convention. Each rule below is the one that catches it.

1. Every `it` and every hook lives inside a top-level `describe`
   (`vitest/require-top-level-describe`).
2. Use `it`, never `test` (`vitest/consistent-test-it`).
3. No two tests in the same `describe` share a title
   (`vitest/no-identical-title`).
4. Every test asserts. One that asserts only through a custom helper must have
   that helper registered in `vitest/expect-expect`'s `assertFunctionNames` in
   `eslint.config.ts`, or it is reported as assertion-less.
5. `expect(actual, message)` is allowed on purpose (`vitest/valid-expect` runs
   with `maxArgs: 2`): the message is often what makes a CI-only failure
   diagnosable.
6. No `.only` reaches CI (`vitest/no-focused-tests`).
7. The plugin's validity rules are on too — `vitest/valid-title`,
   `vitest/valid-describe-callback`, `vitest/valid-expect-in-promise`,
   `vitest/no-standalone-expect`.

## Test conventions (NOT enforced — no rule catches these)

1. A file's outermost `describe` is named after the module under test (e.g.
   `src/app-paths.ts`). That is what keeps a file-wide `beforeEach`/`afterEach`
   covering the whole file: never move a file-wide hook into one of several
   sibling describes, it silently stops running for the others. ESLint only
   checks that the hook is inside SOME top-level describe, not which one.
2. The generic budget is 15s (`testTimeout`/`hookTimeout` in
   `vitest.config.ts`). A test that genuinely needs longer passes its own
   timeout as the third argument to `it`; do not raise the generic budget to
   accommodate one slow test.
3. Coverage is opt-in via `pnpm test:coverage`; `pnpm test` stays fast. Its
   thresholds are a ratchet sitting just under the numbers the suite produces
   today — raise them, never lower them.

## Quality gate

Before considering a change done, run `pnpm quality`
(`typecheck` + `lint:strict` + `deadcode` + `deps:check` + `test`) and `pnpm format`.
