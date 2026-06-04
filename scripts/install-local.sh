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

step() { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }

# ─── 1. stop running instances ─────────────────────────────────────────
step "Stopping any running DevBar…"
# Installed bundle (either /Applications or ~/Applications)
pkill -f "/Applications/DevBar.app" 2>/dev/null || true
# Bundle running straight from dist/ (orphan from a previous build)
pkill -f "devbar/dist/DevBar-darwin"   2>/dev/null || true
# Dev mode (`npm start`)
pkill -f "devbar/node_modules/electron/dist/Electron.app" 2>/dev/null || true
# Generic fallback: any process whose path contains DevBar.app
pkill -f "DevBar.app/Contents/MacOS/DevBar" 2>/dev/null || true
# Give the OS a moment to release file locks on the bundle.
sleep 1

# ─── 2. pack ───────────────────────────────────────────────────────────
step "Packaging (electron-packager)…"
npm run pack >/tmp/devbar-pack.log 2>&1 || {
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
