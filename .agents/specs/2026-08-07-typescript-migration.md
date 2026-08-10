# Strict TypeScript migration

## Request

Migrate every repository-authored JavaScript-family source file in DevBar to strict, production-grade TypeScript while preserving application behavior, Electron security boundaries, packaging, release validation, and repository automation.

The migration is completion-driven: authored `.js`, `.jsx`, `.mjs`, and `.cjs` files must reach zero, TypeScript must be strict, renderer/main/preload IPC contracts must be statically shared, all tests and tooling must migrate, generated JavaScript must remain build output, and every migration-relevant GitHub check must finish successfully before delivery is reported complete.

## Evidence

- Original migration baseline: `04301259ac4579c83eec27a632eea23817225521` (`0.4.2`).
- Branch synchronized against current `main` baseline `21dc43e781d095f95d699b2c1c21a31617d738c6` (`0.4.3`) before final delivery.
- Runtime/tooling: Node.js 22+, pnpm 10, Electron 43, Vitest 4, ESLint 10, Knip 6, dependency-cruiser 18, electron-store, menubar, and custom macOS packaging/release scripts.
- Pre-migration `package.json#main` pointed to `src/main.js`; the migrated runtime entry is `build/src/main.js`.
- Authored JavaScript exists in the Electron main process, preload, renderer, tests, Node utility/release scripts, and root tooling configuration.
- Renderer lint configuration currently models classic-script cross-file globals, confirming accidental global coupling that must be removed rather than preserved.
- Preload currently duplicates silence-pattern logic because requiring a sibling module from the packaged preload previously broke `contextBridge` initialization.
- CI currently runs frozen install, strict lint, formatting, Knip, dependency-cruiser, tests, and Electron packaging, but has no TypeScript typecheck or zero-authored-JavaScript guard.
- Release validation currently filters and executes JavaScript release script/test paths, so those references must migrate with the files.
- The last pre-migration pull request validated successfully in CI, CodeQL, and the macOS release-validation workflow.
- No Docker, Compose, or Dev Container configuration was found in the current repository search.

## Scope

### In scope

- All authored application, preload, renderer, utility/release script, test, and JavaScript tooling source.
- Strict TypeScript compiler configuration and deterministic generated runtime output.
- Shared domain and Electron IPC/renderer API contracts.
- Runtime validation at untrusted persistence/import/IPC boundaries where required by the existing behavior.
- Explicit renderer module dependencies and HTML entrypoint updates.
- Type-aware ESLint, TypeScript-aware Knip and dependency-cruiser configuration.
- Package scripts, shell wrappers, all impacted GitHub workflows, and a permanent tracked-source JavaScript guard.
- Version bump and Spanish changelog entry required by `AGENTS.md`.
- Regression tests required to keep existing behavior and to remove duplicated-test production algorithms where practical.

### Out of scope

- Product redesign or unrelated feature work.
- Public API/behavior changes that are not required by the TypeScript runtime/build model.
- Backend, external services, authentication, database, signing, notarization, or release-policy redesign.
- Merge, tag creation, GitHub Release publication, or deployment.

## Decision

- Keep the existing modular Electron architecture and migrate boundaries rather than introducing a new service architecture.
- Use strict TypeScript as the authored language and emit runtime JavaScript only into an ignored generated build directory.
- Keep Electron renderer isolation (`contextIsolation`, sandboxing where present, and `nodeIntegration: false`) and expose only the narrow typed contextBridge API.
- Centralize the renderer-facing API/IPC payload shapes in one authoritative contract used by main, preload, and renderer declarations.
- Remove classic renderer global coupling by using explicit ES-module imports and generated browser modules.
- Keep preload self-contained at runtime. Shared pure behavior needed by renderer/main will be compiled for each target instead of requiring a packaged preload sibling.
- Prefer the existing toolchain and add only dependencies required for TypeScript compilation and mature type-aware ESLint support.
- Preserve persistence schema/version semantics and distinguish runtime-untrusted persisted/imported/IPC values from normalized trusted domain values through explicit guards/normalizers. `unknown` is allowed only at those trust boundaries and must be narrowed by a validator before entering trusted domain code; `any` and unchecked assertions remain forbidden.
- Use a patch version bump because the intended migration is internal and behavior-preserving.

## Risks

- Electron preload execution differs from normal Node execution; packaged preload loading is an explicit acceptance gate.
- Renderer conversion can expose hidden ordered-script dependencies; HTML/module loading and event timing must be regression-tested.
- Persistence and IPC values cross runtime trust boundaries; compile-time types alone cannot validate them.
- macOS release scripts depend on generated runtime files and exact artifact naming; release validation must run after the build-path migration.
- Workflow path filters can silently stop release validation if old `.js` paths are merely renamed; filters will be audited explicitly.
- The current execution sandbox cannot directly clone GitHub or install packages from the registry. GitHub Actions and connector-provided artifacts will therefore be used as the authoritative executable validation environment, and no local command result will be claimed unless it was actually run.

## Acceptance criteria

- Zero tracked/authored `.js`, `.jsx`, `.mjs`, or `.cjs` files remain.
- All app, renderer, preload, Node scripts, tests, and JavaScript tooling are TypeScript or non-JavaScript declarative configuration.
- Strict compiler protections remain enabled, including unchecked-index and exact-optional handling.
- Authored TypeScript contains zero explicit `any`, zero `@ts-ignore`, zero `@ts-nocheck`, and no unsafe double assertion. Explicit `unknown` is limited to runtime trust-boundary inputs and is validated/narrowed before use as a domain value.
- `window.api` and IPC method/event payloads are statically shared and preload remains narrow and secure.
- Renderer code uses explicit modules and safe DOM lookup/narrowing.
- Persisted/imported configuration behavior and legacy compatibility remain unchanged and runtime-validated.
- Existing tests are migrated without skips or weakened assertions; migration regressions are covered.
- `quality` includes typecheck and passes with strict lint, dead-code, dependency, and test checks.
- Formatting, clean build, Electron package smoke, release artifact tests, and macOS release validation pass.
- CI permanently enforces TypeScript and zero authored JavaScript.
- All impacted workflows reference the new source/build paths and relevant triggered checks complete successfully.
- Version and `CHANGELOG.md` follow `AGENTS.md`.
- Final diff contains no generated JavaScript, stale JavaScript-source reference, migration-only workflow, secret, or unrelated product change.

## Checks

- Baseline repository inventory and workflow inspection.
- TypeScript typecheck.
- ESLint strict mode.
- Prettier check.
- Knip.
- dependency-cruiser.
- Full Vitest suite and coverage when configured.
- Clean generated build.
- Electron packaging smoke.
- Release artifact regression tests.
- macOS `release:mac` dry run through the existing release-validation workflow.
- Tracked JavaScript-family audit.
- Obsolete `.js` reference audit.
- Unsafe TypeScript escape-hatch audit.
- PR CI, release validation, CodeQL/security checks, and every other migration-relevant status check to terminal success.

## Rollback

Revert the migration pull request. Generated build output is ignored and no tag, release, deployment, or remote data migration is performed by this work.

## Delivery

- Branch: `refactor/typescript-migration`
- Source publication commit: `f4bb935d574cb187e3800f8025cceaf3a4c72dab`
- Authoritative validation commit: `1549945fc79e4c2961ba4092428cdf6622aee286`
- Pull request: #44 (`refactor: migrate DevBar to strict TypeScript`)
- Merge/release: explicitly excluded without owner approval

## Status

Implementation, remote TypeScript publication, and authoritative GitHub validation are complete. The pull request remains intentionally unmerged pending owner approval.

Local evidence from the final candidate tree:

- TypeScript typecheck passes for Node/main, preload, renderer, and tests.
- ESLint type-aware strict mode, Prettier, Knip, and dependency-cruiser pass.
- Vitest passes 20/20 files and 429/429 tests without skips.
- Clean build succeeds, including bundled `build/src/preload.cjs`.
- Authored JavaScript-family audit reports zero files outside ignored generated/dependency output.
- Unsafe TypeScript escape audit reports zero explicit `any`, `@ts-ignore`, or `@ts-nocheck`.
- GitHub CI passes frozen install, strict TypeScript/source policy, static quality, all tests, and package smoke.
- CodeQL passes both Actions and JavaScript/TypeScript analyses.
- macOS release validation passes frozen install, moderate-or-higher dependency audit, release artifact regression tests, `release:mac`, checksum evidence generation, and artifact upload.
- The transitive `nanoid` audit finding was fixed with an exact `3.3.17` pnpm override and a lockfile regenerated by pnpm 10.32.1 in GitHub Actions; the subsequent audit passes.
- Full Electron/macOS packaging is therefore verified by the authoritative GitHub/macOS gate rather than inferred from the Linux sandbox.
