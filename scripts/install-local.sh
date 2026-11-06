#!/usr/bin/env bash
# install-local — pack DevBar and install it to /Applications.
#
# Steps:
#   1. Stop only a DevBar running FROM dist/ — the pack overwrites its
#      bundle. The installed copy and a `npm start` instance keep running
#      (with the user's services) through the slow build.
#   2. electron-packager → dist/DevBar-darwin-<arch>/DevBar.app. A failed
#      pack exits here, with the running DevBar left untouched.
#   3. Stop any running DevBar (packaged or `npm start`).
#   4. Replace /Applications/DevBar.app (or ~/Applications fallback).
#   5. Strip Gatekeeper quarantine (app is unsigned).
#   6. Symlink the app log into the repo.
#   7. Relaunch.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

step() { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }

# pgrep/pkill -f take EXTENDED regexes: a checkout under a directory with
# metacharacters (parens, brackets, dots…) would stop matching — or worse,
# over-match. Escape the four patterns once and reuse them everywhere
# (kill waves, verification, service-tree walk).
ere_escape() { printf '%s' "$1" | sed -e 's/[][\\.^$*+?(){}|]/\\&/g'; }
# Installed bundle (either /Applications or ~/Applications)
PAT_APP="$(ere_escape "/Applications/DevBar.app")"
# Bundle running straight from this repo's dist/ (orphan from a previous
# build) — anchored to the actual checkout path, not a folder name guess.
PAT_DIST="$(ere_escape "${ROOT}/dist/DevBar-darwin")"
# Dev mode (`npm start` / `pnpm start`) out of this checkout — anchored
# on the electron binary so the pnpm/node process running THIS
# install (node_modules/.bin in its command line) is never hit.
PAT_DEV="$(ere_escape "${ROOT}/node_modules/electron")"
# Generic fallback: any process whose path contains DevBar.app
PAT_BIN="$(ere_escape "DevBar.app/Contents/MacOS/DevBar")"

# True while any process matches one of the given patterns. Callers pass
# the SAME set their kill waves use, or an instance the verification
# cannot see would pass it and race the next step.
instances_alive() {
  local pattern
  for pattern in "$@"; do
    pgrep -f "$pattern" >/dev/null 2>&1 && return 0
  done
  return 1
}

# stop_instances <before-what> <pattern>… — stop every DevBar matching the
# patterns, verify it, force it, and abort if anything survives.
stop_instances() {
  local before="$1" pattern
  shift
  # The service trees FIRST. The running instance's commands spawn detached
  # into their own process groups, so the pkill wave below would leave the
  # user's dev servers alive (holding their ports). The shared helper walks
  # each matching instance's children and signals their process groups.
  # The helper only exits non-zero when a detached service group SURVIVES
  # SIGKILL — such a group still holds its port, so the install must fail
  # loudly instead of swapping the bundle under a live service.
  if ! node --experimental-strip-types scripts/lib/kill-trees.ts "$@"; then
    warn "A service group survived the forced stop — aborting before $before."
    exit 1
  fi
  for pattern in "$@"; do pkill -f "$pattern" 2>/dev/null || true; done
  # Wave 2: a leftover process is exactly how a reinstall half-resolves, so
  # verify the kill instead of assuming it.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    instances_alive "$@" || break
    sleep 0.5
  done
  if instances_alive "$@"; then
    # Wave 3: a leftover process still holds the single-instance socket and
    # turns the relaunch into a silent second instance — force it.
    warn "A DevBar process ignored the graceful stop — forcing it."
    for pattern in "$@"; do pkill -9 -f "$pattern" 2>/dev/null || true; done
    for _ in 1 2 3 4 5 6; do
      instances_alive "$@" || break
      sleep 0.5
    done
    if instances_alive "$@"; then
      # A process that outlives SIGKILL still holds the single-instance
      # socket: the relaunch would become a silent second instance.
      # Fail loudly instead of installing under a surviving process.
      warn "A DevBar process survived even the forced stop — it keeps the single-instance lock; quit it manually and re-run."
      exit 1
    fi
    ok "all previous instances stopped"
  fi
  # Give the OS a moment to release file locks on the bundle.
  sleep 1
}

# ─── 1. stop an instance running from dist/ ───────────────────────────
# Re-packing overwrites dist/DevBar-darwin-<arch>/DevBar.app: an instance
# running from there must stop first. Everything else keeps running.
step "Stopping any DevBar running from the build output (dist/)…"
stop_instances "packing" "$PAT_DIST"

# ─── 2. pack ───────────────────────────────────────────────────────────
step "Packaging (electron-packager)…"
pnpm run pack >/tmp/devbar-pack.log 2>&1 || {
  warn "pack failed — the running DevBar was left untouched. Last 20 lines:"
  tail -20 /tmp/devbar-pack.log
  exit 1
}

APP_PATH=$(find dist -maxdepth 2 -type d -name "DevBar.app" 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
  warn "could not locate built DevBar.app under dist/ — the running DevBar was left untouched"
  exit 1
fi
ok "built: $APP_PATH"

# ─── 3. stop running instances ─────────────────────────────────────────
# Only now, with a packed app in hand: every pattern, so neither the
# installed copy nor a dev instance survives to race the relaunch.
step "Stopping any running DevBar…"
stop_instances "install" "$PAT_APP" "$PAT_DIST" "$PAT_DEV" "$PAT_BIN"

# ─── 4. install ────────────────────────────────────────────────────────
TARGET_DIR="/Applications"
if [ ! -w "$TARGET_DIR" ]; then
  TARGET_DIR="$HOME/Applications"
  mkdir -p "$TARGET_DIR"
  warn "/Applications not writable, using $TARGET_DIR instead"
fi

step "Installing to $TARGET_DIR/DevBar.app"
rm -rf "$TARGET_DIR/DevBar.app"
cp -R "$APP_PATH" "$TARGET_DIR/"

# ─── 5. unquarantine ───────────────────────────────────────────────────
# Unsigned bundles get a com.apple.quarantine xattr after copy, which
# triggers the "DevBar can't be opened because Apple cannot check it"
# Gatekeeper dialog on first launch. Stripping it makes the launch silent.
xattr -dr com.apple.quarantine "$TARGET_DIR/DevBar.app" 2>/dev/null || true

# ─── 6. log symlink ────────────────────────────────────────────────────
# The packaged .app writes its log to ~/Library/Logs/DevBar/app.log.
# Drop a symlink at the repo root so developers can `tail -f app.log`
# directly from the project. `app.log` is already in .gitignore via *.log.
LOG_TARGET="$HOME/Library/Logs/DevBar/app.log"
mkdir -p "$(dirname "$LOG_TARGET")"
touch "$LOG_TARGET"
if [ ! -L "app.log" ] || [ "$(readlink app.log)" != "$LOG_TARGET" ]; then
  rm -f app.log
  ln -s "$LOG_TARGET" app.log
  ok "Symlinked $(pwd)/app.log → $LOG_TARGET"
fi

# ─── 7. launch ─────────────────────────────────────────────────────────
step "Launching"
open "$TARGET_DIR/DevBar.app"

ok "Installed at $TARGET_DIR/DevBar.app"
ok "Tail logs with: pnpm logs   (file: $LOG_TARGET)"
