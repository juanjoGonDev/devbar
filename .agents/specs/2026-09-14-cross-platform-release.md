# Cross-platform runtime and release pipeline

## Request

Adapt DevBar to any OS — auto-start, scheduled/pre-script boot behavior, build
CI for every platform, and build validation ("tests de todas las builds") for
Raspberry Pi, Windows and Linux. The previous base was macOS only.

## Decision

- **Runtime**: `src/platform.ts` (OS predicates, user shell, label), pure
  `src/autostart.ts` (Linux XDG `~/.config/autostart/devbar.desktop`, `--login`
  argv contract), per-OS PATH handling in `src/path-helper.ts`, and a
  cross-platform `src/process-manager.ts` (Windows `cmd.exe /d /s /c`,
  POSIX user-shell `-ic`, `taskkill /pid /T /F` on Windows, detached POSIX
  spawns).
- **Auto-start**: macOS `setLoginItemSettings` (hidden), Windows
  `setLoginItemSettings` + `--login` arg, Linux XDG desktop entry with
  `Exec=<exe> --login`. "Opened at login" detection: native on macOS, `--login`
  argv elsewhere (`DEVBAR_FORCE_LOGIN=1` override for testing kept).
- **Self-update**: pure `src/self-update.ts` facade over
  `src/self-update-macos.ts` (bundle swap), `src/self-update-linux.ts`
  (AppImage in-place swap with wait/rollback, `deb` → assisted reinstall) and
  `src/self-update-windows.ts` (installed → silent NSIS re-run; portable single
  exe → in-place file swap via a generated `.bat`). Every non-macOS download
  is SHA-256 verified against `SHA256SUMS.txt` before install.
- **Packaging**: macOS keeps the `@electron/packager` + DMG/ZIP pipeline
  (ad-hoc signing and notification identity care). Windows and Linux use
  electron-builder (programmatic API in `scripts/package-win-linux.ts`):
  NSIS one-click per-user + portable exe (x64, arm64); AppImage + deb
  (x64, arm64, armv7). Artifact names live in
  `scripts/release-artifacts.ts` (single source of truth, 14 artifacts).
- **App identity**: packaged builds pin `app.name = 'DevBar'` on every OS so
  userData/logs/notification folders are consistent (dev mode unchanged).
- **CI**: `ci.yml` gains a 3-OS `build` job that compiles, verifies
  (`pnpm run verify:win|linux`, `release:mac`) and LAUNCHES each packaged
  binary via a built-in smoke mode (`--devbar-smoke` / `DEVBAR_SMOKE=1` prints
  `DEVBAR_SMOKE_OK` and exits; creates the platform tray, skips windows/
  commands/autostart). Windows smoke: NSIS install → installed exe + portable
  exe. Linux smoke: AppImage under `xvfb` + `dpkg -i` → installed binary.
  `release-validation.yml` gets matching Windows/Linux dry-run jobs.
- **Release**: `release.yml` builds the three platforms in parallel, merges the
  artifacts in a read-only `assemble` job (writes the full `SHA256SUMS.txt`
  via `scripts/release-manifest.ts`, verifies the complete set with
  `verify-release-artifacts.js`), then a privileged `publish` job (no checkout)
  tags and publishes all 14 artifacts + manifest through the GitHub API.
  The detect job's expected-asset list is the 14-artifact contract.
  CodeQL constraint: this workflow is cache-writable (push to main /
  workflow_dispatch), so it may not check out a ref derived from job outputs
  or inputs (cache-poisoning alerts) — build/assemble jobs use the plain
  immutable event-sha checkout. In this repo's flow the version-introducing
  commit is the push HEAD (detect warns when they differ); the tag and
  release still target the resolved release_sha. Dispatch has no inputs:
  recovery re-resolves the current main version against full first-parent
  history (the former `version` input was a verification token, not data).
- **Windows icon**: `assets/icon.ico` (16 → 256) generated from `icon.png`.

## Acceptance criteria

- `pnpm typecheck`, `pnpm lint:strict`, `pnpm format:check`, `pnpm deadcode`,
  `pnpm deps:check` and `pnpm test` pass (739 tests).
- Each OS job in CI builds, verifies contents (PE `MZ` header, AppImage magic,
  `dpkg -c` desktop entry + icon, mac `hdiutil`/`lipo` checks) and launches
  the packaged binary, asserting `DEVBAR_SMOKE_OK`.
- The publish job refuses to create a release unless all 14 artifacts plus a
  consistent full `SHA256SUMS.txt` verify.
- `pnpm run logs`, auto-start and the boot (pre-script) path work on macOS,
  Windows and Linux without macOS-only assumptions in the runtime modules.
- No authored JavaScript files are added (the repo's TypeScript-only policy is
  preserved; electron-builder's broken `.d.ts` is worked around with a minimal
  typed surface in `scripts/electron-builder.d.ts` + tsconfig `paths`, keeping
  `skipLibCheck: false`).
