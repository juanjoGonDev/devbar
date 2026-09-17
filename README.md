<p align="center">
  <img src="assets/icon-readme.png" width="160" alt="DevBar app icon" />
</p>

<h1 align="center">DevBar</h1>

<p align="center">
  A menu-bar / tray launcher for your local development services, on macOS,
  Windows and Linux (Raspberry Pi included).<br/>
  Start &amp; stop commands, switch git branches per group, run actions, watch logs &mdash; all from the tray.
</p>

---

## Download

Download the latest installers from
[GitHub Releases](https://github.com/juanjoGonDev/devbar/releases/latest):

**macOS** (ad-hoc signed, but not Developer ID signed or notarized — the
first launch may need an explicit approval in **System Settings → Privacy
& Security**):

- `DevBar-<version>-macos-arm64.dmg` — Apple Silicon Macs.
- `DevBar-<version>-macos-x64.dmg` — Intel Macs.
- Matching `.zip` files — portable application archives.

**Windows** (x64 and Windows-on-ARM `arm64`):

- `DevBar-<version>-win-<arch>-setup.exe` — one-click per-user installer
  (no admin needed; installs to `%LOCALAPPDATA%\Programs\DevBar`).
- `DevBar-<version>-win-<arch>-portable.exe` — single self-contained exe,
  run it from any folder.

**Linux** (x64, `arm64` = Raspberry Pi 4/5 64-bit, `armv7` = 32-bit Pi OS):

- `DevBar-<version>-linux-<arch>.AppImage` — run straight from the file
  (recommended; the in-app updater swaps it in place).
- `DevBar-<version>-linux-<arch>.deb` — `sudo dpkg -i …`.

- `SHA256SUMS.txt` — integrity hashes for every artifact.

## Features

- **Groups of commands** — bundle every `pnpm start:*` of a monorepo under one group sharing the same `cwd` and git repo.
- **Single or multi run mode** — pick one command at a time, or start several in parallel.
- **One-shot actions** — fire-and-forget commands per group (`pnpm install`, run tests, etc.).
- **Icon battery** — pick from 115 curated emojis to tell groups, commands and actions apart at a glance.
- **Live status colors** — a dot tinted green / yellow / red follows each command's stdout for warns and errors.
- **Live uptime** — see how long each command has been running, right inside the popover and the logs window.
- **Searchable branch combobox** — type to filter, ✓ marks the current branch.
- **Native folder picker** for paths, native save / open dialogs for full config JSON import / export.
- **Dynamic env editor** with per-entry on/off, a master "enable all" switch, group-level env, and an opt-in `Heredar variables del grupo` toggle for actions.
- **Native macOS chrome** — `hiddenInset` titlebars, vibrancy, fake traffic lights inside modal dialogs, dark-mode aware. On Windows/Linux the same dialogs use a solid dark theme without the fake traffic lights.
- **Cross-platform** — menu bar (macOS), system tray / notification area (Windows), and status-notifier tray (Linux, incl. Raspberry Pi). Auto-start, scheduled runs, pre-scripts and in-app self-update all work on every OS.

## Run in dev

```bash
pnpm install
pnpm run fetch-electron   # one-time: downloads the Electron binary for `pnpm start`
pnpm start
```

> Requires pnpm ≥ 10.16 and Node ≥ 22.13.0 (enforced via `engine-strict`)
> on macOS, Windows and Linux — no bash needed (the dev build runs in Node).
> Use the pnpm pinned in `package.json` (`pnpm@10.32.1`), e.g. via corepack
> (`corepack enable`) — other pnpm versions can flag the lockfile as out of
> sync. After a `git pull` that changes dependencies, run `pnpm install`
> again before building.
> Electron 42 no longer ships a postinstall, so `pnpm start` (dev mode)
> needs `fetch-electron` once. Packaging (`pnpm run pack`) downloads its
> own Electron and does not need this step.

The UI theme follows your OS by default; you can force light or dark under
**Configuración → General → Tema** (auto / claro / oscuro).

A status icon (the same one shown above) appears on the right side of the menu bar:

- gray dot — all services stopped
- green — running, 0 warns / 0 errors
- yellow — at least one warning detected in stdout/stderr
- red — at least one error detected, or a process died

Click the icon to open the popover. Click **Configuración** to add and edit groups.

## Build the installers

The commands are OS-agnostic: a thin router (`scripts/platform.ts`)
detects the host and dispatches to the matching implementation — the
original macOS bash pipeline, or electron-builder on Windows and Linux.
The app is pure JS (only the Electron runtime is platform-specific), so
Windows artifacts can be built from any host; **Linux artifacts require
a Linux host or Docker** (electron-builder's contract for AppImage/deb
targets), which is why CI builds them on `ubuntu-latest`.

| What                         | Command (on that OS)           | Output                                                                                             |
| ---------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Unpacked dev app (host arch) | `pnpm run pack`                | macOS `dist/DevBar-darwin-*` · win `dist/electron-builder/win-unpacked` · linux `…/linux-unpacked` |
| macOS DMG + ZIP              | `pnpm run dist` (= `dist:mac`) | `dist/release/DevBar-<v>-macos-{arm64,x64}.{dmg,zip}` + `SHA256SUMS.txt`                           |
| Windows NSIS + portable      | `pnpm run dist`                | `dist/electron-builder/DevBar-<v>-win-{x64,arm64}-{setup,portable}.exe`                            |
| Linux AppImage + deb         | `pnpm run dist`                | `dist/electron-builder/DevBar-<v>-linux-{x64,arm64,armv7}.{AppImage,deb}`                          |
| Build + verify (this OS)     | `pnpm run release`             | Runs `dist` then `release:verify` for the host OS — one command from build to validated artifacts  |

`pnpm run verify` runs the matching verifier (artifact contract + contents)
for the current OS. macOS keeps its own packager pipeline (ad-hoc signing +
notification identity); Windows and Linux are built with
**electron-builder**.

`pnpm run release` is the OS-agnostic "make a release and prove it" command:
it builds the full artifact set for the host OS and runs the matching
verifier in one step. On macOS it is exactly `release:mac`; on Windows and
Linux it is `dist` + `release:verify`, so a release is one command on every
OS instead of a macOS-specific name.

The release workflow builds all three platforms in parallel, launches each
packaged binary as a smoke test (NSIS install + portable on Windows, AppImage +
deb under `xvfb` on Linux, packaged app on macOS), assembles the full
`SHA256SUMS.txt`, and publishes all 14 artifacts.

## Install / reinstall

`pnpm run install-local` (or `install-local:dev` with the dev panel) works
on every OS — stop any running DevBar, repack, replace the local install,
relaunch. Stopping is done in two waves because a leftover process is
exactly how a reinstall (or an automatic update) half-resolves: the old
instance keeps running while the new one can't replace locked files. First
it kills the packaged app (and a `pnpm start` dev instance of this repo),
then it **verifies** nothing is left alive before touching the install
location — if a process survives, it says so loudly instead of swapping
files under a live process:

- **macOS** — replaces `/Applications/DevBar.app` (falls back to
  `~/Applications` if not writable) and strips the Gatekeeper quarantine
  flag (the bundle is ad-hoc signed, not Developer ID signed or
  notarized).
- **Windows** — replaces `%LOCALAPPDATA%\Programs\DevBar`, the same
  per-user location the NSIS installer uses (the in-app updater keeps
  working).
- **Linux** — replaces `~/.local/share/DevBar` and links `devbar` into
  `~/.local/bin` when it exists.

For a "real" install, run the `setup.exe` installer (Windows), drop the
`portable.exe` in any folder, run the `.AppImage` directly, or
`sudo dpkg -i` the `.deb` (Linux).

## Logs

```bash
pnpm run logs
```

Prints the per-OS log location and tails it live:
`~/Library/Logs/DevBar/app.log` (macOS), `%APPDATA%\DevBar\logs\app.log`
(Windows), `$XDG_CONFIG_HOME/DevBar/logs/app.log` (Linux — `~/.config`
when `XDG_CONFIG_HOME` is unset).

## Simulating a login/boot launch

Group **pre-scripts** only auto-run when DevBar was started by the OS at login —
not on a manual reopen. To exercise that boot path without rebooting, launch the
packaged binary with `DEVBAR_FORCE_LOGIN=1`, which forces the "opened at login"
branch:

```bash
# macOS — stop any running instance first, then:
DEVBAR_FORCE_LOGIN=1 /Applications/DevBar.app/Contents/MacOS/DevBar
```

```powershell
# Windows (PowerShell) — stop the running instance first, then:
$env:DEVBAR_FORCE_LOGIN="1"; & "$env:LOCALAPPDATA\Programs\DevBar\DevBar.exe"
```

```bash
# Linux (AppImage) — stop the running instance first, then:
DEVBAR_FORCE_LOGIN=1 ./DevBar.AppImage
```

On macOS, `open -a DevBar` does not propagate env vars, so launch the binary
directly. The flag is inert in normal use (nobody sets it), so it is safe to
ship — it only short-circuits the login check for testing.

## Self-update

DevBar checks GitHub Releases and offers the matching installer for your
platform. The install strategy is per-OS:

- **macOS** — swap the `.app` bundle in place and relaunch.
- **Linux** — swap the `.AppImage` in place (wait for exit, move aside, copy,
  relaunch; rolls back on failure). `.deb` installs update by re-running the
  new `.deb`.
- **Windows** — installed apps re-run the silent NSIS installer after quit;
  the portable exe swaps itself in place.

Every downloaded artifact is verified against `SHA256SUMS.txt` before install,
on all three platforms — an update whose manifest cannot be fetched is
aborted rather than installed unverified. macOS additionally verifies the
bundle's ad-hoc code signature when it is unpacked.

## Tests

```bash
pnpm test
```

Vitest covers the pure modules (`groups-model`, `compound-id`,
`parse-command`, `path-helper`, `format-uptime`, `config-io`,
`process-manager`, `autostart`, `self-update`, `release-artifacts`). The CI
`build` job additionally compiles, verifies and **launches** the packaged
binary on each of macOS, Windows and Linux.

## Where is the config?

| OS      | Path                                                   |
| ------- | ------------------------------------------------------ |
| macOS   | `~/Library/Application Support/DevBar/config.json`     |
| Windows | `%APPDATA%\DevBar\config.json`                         |
| Linux   | `${XDG_CONFIG_HOME:-$HOME/.config}/DevBar/config.json` |

You can also export it to JSON or import another machine's config from
**Configuración → Copia de seguridad**.

## Star History

<a href="https://www.star-history.com/?type=date&repos=juanjoGonDev%2Fdevbar">
 <picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=juanjoGonDev/devbar&type=date&theme=dark&legend=top-left&sealed_token=SiobjIhLMyb_GKNYtWMigQfCvWNOgIgmnCAeSQxe42HTDl7UQDf0p6jcrSZzK75UogchLVfpVpgeAL6lfbd6aSoMGp92ZlqHnG88aesOfi4wwbCaV-_1VmYmwUFAiJeTRUnXAopttQWM7cBQsdgOvV3I0XG3Rxl6kN6QKkie2m9XOMbWQcOU_qGT8Tjc" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=juanjoGonDev/devbar&type=date&legend=top-left&sealed_token=SiobjIhLMyb_GKNYtWMigQfCvWNOgIgmnCAeSQxe42HTDl7UQDf0p6jcrSZzK75UogchLVfpVpgeAL6lfbd6aSoMGp92ZlqHnG88aesOfi4wwbCaV-_1VmYmwUFAiJeTRUnXAopttQWM7cBQsdgOvV3I0XG3Rxl6kN6QKkie2m9XOMbWQcOU_qGT8Tjc" />
  <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=juanjoGonDev/devbar&type=date&legend=top-left&sealed_token=SiobjIhLMyb_GKNYtWMigQfCvWNOgIgmnCAeSQxe42HTDl7UQDf0p6jcrSZzK75UogchLVfpVpgeAL6lfbd6aSoMGp92ZlqHnG88aesOfi4wwbCaV-_1VmYmwUFAiJeTRUnXAopttQWM7cBQsdgOvV3I0XG3Rxl6kN6QKkie2m9XOMbWQcOU_qGT8Tjc" />
 </picture>
</a>
