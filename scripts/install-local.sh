#!/usr/bin/env bash
# install-local — pack DevBar and install it to /Applications.
#
# Steps:
#   1. Stop any running DevBar (packaged or `npm start`).
#   2. electron-packager → dist/DevBar-darwin-<arch>/DevBar.app
#   3. Replace /Applications/DevBar.app (or ~/Applications fallback).
#   4. Strip Gatekeeper quarantine (app is unsigned).
#   5. Relaunch.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

step() { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }

# ─── 1. stop running instances ─────────────────────────────────────────
step "Stopping any running DevBar…"
# The service trees FIRST. The running instance's commands spawn detached
# into their own process groups, so the pkill wave below would leave the
# user's dev servers alive (holding their ports). The shared helper walks
# each matching instance's children and signals their process groups.
node --experimental-strip-types scripts/lib/kill-trees.ts \
  "/Applications/DevBar.app" \
  "${ROOT}/dist/DevBar-darwin" \
  "${ROOT}/node_modules" \
  "DevBar.app/Contents/MacOS/DevBar" 2>/dev/null || true
# Installed bundle (either /Applications or ~/Applications)
pkill -f "/Applications/DevBar.app" 2>/dev/null || true
# Bundle running straight from this repo's dist/ (orphan from a previous
# build) — anchored to the actual checkout path, not a folder name guess.
pkill -f "${ROOT}/dist/DevBar-darwin" 2>/dev/null || true
# Dev mode (`npm start` / `pnpm start`) out of this checkout — anchored
# on the electron binary so the pnpm/node process running THIS
# install (node_modules/.bin in its command line) is never hit.
pkill -f "${ROOT}/node_modules/electron" 2>/dev/null || true
# Generic fallback: any process whose path contains DevBar.app
pkill -f "DevBar.app/Contents/MacOS/DevBar" 2>/dev/null || true
# Every pattern the kill wave uses — the verification must check the same
# set, or a dev instance would pass verification and race the relaunch.
# The dev check is anchored on the electron binary (a dev instance's
# command line carries the node_modules/electron path; the pnpm/node
# process running THIS install carries node_modules/.bin and must not
# count as an app instance).
devbar_alive() {
  pgrep -f "/Applications/DevBar.app" >/dev/null 2>&1 \
    || pgrep -f "${ROOT}/dist/DevBar-darwin" >/dev/null 2>&1 \
    || pgrep -f "${ROOT}/node_modules/electron" >/dev/null 2>&1 \
    || pgrep -f "DevBar.app/Contents/MacOS/DevBar" >/dev/null 2>&1
}
# Wave 2: a leftover process is exactly how a reinstall half-resolves, so
# verify the kill instead of assuming it.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  devbar_alive || break
  sleep 0.5
done
if devbar_alive; then
  # Wave 3: a leftover process still holds the single-instance socket and
  # turns the relaunch into a silent second instance — force it.
  warn "A DevBar process ignored the graceful stop — forcing it."
  pkill -9 -f "/Applications/DevBar.app" 2>/dev/null || true
  pkill -9 -f "${ROOT}/dist/DevBar-darwin" 2>/dev/null || true
  pkill -9 -f "${ROOT}/node_modules/electron" 2>/dev/null || true
  pkill -9 -f "DevBar.app/Contents/MacOS/DevBar" 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    devbar_alive || break
    sleep 0.5
  done
  if devbar_alive; then
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

# ─── 2. pack ───────────────────────────────────────────────────────────
step "Packaging (electron-packager)…"
pnpm run pack >/tmp/devbar-pack.log 2>&1 || {
  warn "pack failed — last 20 lines:"
  tail -20 /tmp/devbar-pack.log
  exit 1
}

APP_PATH=$(find dist -maxdepth 2 -type d -name "DevBar.app" 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
  warn "could not locate built DevBar.app under dist/"
  exit 1
fi
ok "built: $APP_PATH"

# ─── 3. install ────────────────────────────────────────────────────────
TARGET_DIR="/Applications"
if [ ! -w "$TARGET_DIR" ]; then
  TARGET_DIR="$HOME/Applications"
  mkdir -p "$TARGET_DIR"
  warn "/Applications not writable, using $TARGET_DIR instead"
fi

step "Installing to $TARGET_DIR/DevBar.app"
rm -rf "$TARGET_DIR/DevBar.app"
cp -R "$APP_PATH" "$TARGET_DIR/"

# ─── 4. unquarantine ───────────────────────────────────────────────────
# Unsigned bundles get a com.apple.quarantine xattr after copy, which
# triggers the "DevBar can't be opened because Apple cannot check it"
# Gatekeeper dialog on first launch. Stripping it makes the launch silent.
xattr -dr com.apple.quarantine "$TARGET_DIR/DevBar.app" 2>/dev/null || true

# ─── 5. log symlink ────────────────────────────────────────────────────
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

# ─── 6. launch ─────────────────────────────────────────────────────────
step "Launching"
open "$TARGET_DIR/DevBar.app"

ok "Installed at $TARGET_DIR/DevBar.app"
ok "Tail logs with: pnpm logs   (file: $LOG_TARGET)"
