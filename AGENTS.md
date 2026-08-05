# AGENTS.md — working agreements for AI agents on DevBar

Conventions an agent MUST follow when changing this repo. Human-facing docs
live in `README.md`; user-facing release notes live in `CHANGELOG.md`.

## Versioning (MANDATORY, owned by the agent)

Every change bumps the version — the agent does this itself, without being
asked, as part of the same change. Follow semantic versioning:

- **patch** (`0.0.X`) — bug fixes, internal refactors, docs, no behaviour change.
- **minor** (`0.X.0`) — new user-facing functionality (backwards compatible).
- **major** (`X.0.0`) — breaking changes.

Rules:

1. Bump `version` in `package.json` in the same change that introduces the work.
2. When a change mixes fixes and new features, the **feature** wins → bump minor.
3. Add a matching entry to `CHANGELOG.md` (Keep a Changelog format, Spanish),
   written for humans — not raw commit messages.
4. Release notes are produced by `.github/workflows/release.yml` via
   `gh release create --generate-notes` (i.e. from merged PR titles), **not**
   from `CHANGELOG.md`. So for the in-app changelog to read well, the PR title
   must be descriptive, or the PR/release body must carry the `CHANGELOG.md`
   section. Keep `CHANGELOG.md` as the canonical hand-written record regardless.
5. Do not hand-create git tags or GitHub releases — merging a version-changing
   commit to `main` triggers the release pipeline.

## Quality gate

Before considering a change done, run `pnpm quality`
(`lint:strict` + `deadcode` + `deps:check` + `test`) and `pnpm format`.
