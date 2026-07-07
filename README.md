<p align="center">
  <img src="assets/icon-readme.png" width="160" alt="DevBar app icon" />
</p>

<h1 align="center">DevBar</h1>

<p align="center">
  A macOS menu-bar launcher for your local development services.<br/>
  Start &amp; stop commands, switch git branches per group, run actions, watch logs &mdash; all from the menu bar.
</p>

---

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
- **Native macOS chrome** — `hiddenInset` titlebars, vibrancy, fake traffic lights inside modal dialogs, dark-mode aware.

## Run in dev

```bash
pnpm install
pnpm run fetch-electron   # one-time: downloads the Electron binary for `pnpm start`
pnpm start
```

> Requires pnpm ≥ 10.16 and Node ≥ 22 (enforced via `engine-strict`).
> Electron 42 no longer ships a postinstall, so `pnpm start` (dev mode)
> needs `fetch-electron` once. Packaging (`pnpm run pack`) downloads its
> own Electron and does not need this step.

A status icon (the same one shown above) appears on the right side of the menu bar:

- gray dot — all services stopped
- green — running, 0 warns / 0 errors
- yellow — at least one warning detected in stdout/stderr
- red — at least one error detected, or a process died

Click the icon to open the popover. Click **Configuración** to add and edit groups.

## Build a `.app`

```bash
pnpm run pack
```

The bundle ends up in `dist/DevBar-darwin-*`. The icon comes from
`assets/icon.icns` (multi-resolution 16 → 1024).

## Install / reinstall to `/Applications`

```bash
pnpm run install-local
```

Stops any running DevBar (packaged or `pnpm start`), repacks, replaces
`/Applications/DevBar.app`, strips the Gatekeeper quarantine flag (the
bundle is unsigned), and relaunches. Falls back to `~/Applications` if
`/Applications` is not writable.

## Simulating a login/boot launch

Group **pre-scripts** only auto-run when DevBar was opened by macOS at
login (`app.getLoginItemSettings().wasOpenedAtLogin`) — not on a manual
reopen. To exercise that boot path without rebooting, launch the packaged
binary with `DEVBAR_FORCE_LOGIN=1`, which forces the "opened at login"
branch:

```bash
# stop any running instance first
pkill -f "DevBar.app/Contents/MacOS/DevBar"
# launch as if started at login (runs pre-scripts + their confirmation modals)
DEVBAR_FORCE_LOGIN=1 /Applications/DevBar.app/Contents/MacOS/DevBar
```

`open -a DevBar` does NOT propagate env vars, so launch the binary
directly. The flag is inert in normal use (nobody sets it), so it is safe
to ship — it only short-circuits the login check for testing.

## Tests

```bash
pnpm test
```

Vitest covers the pure modules (`groups-model`, `compound-id`,
`parse-command`, `path-helper`, `format-uptime`, `config-io`).

## Where is the config?

`~/Library/Application Support/devbar/config.json`

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

