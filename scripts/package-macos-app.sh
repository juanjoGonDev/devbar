#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly ICON_PATH="$ROOT_DIR/assets/icon.icns"
readonly ARCH=${1:-$(node -p "process.arch")}
readonly OUT_DIR=${2:-"$ROOT_DIR/dist"}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

case "$ARCH" in
  arm64|x64) ;;
  *) fail "Unsupported macOS architecture: $ARCH" ;;
esac

[ -s "$ICON_PATH" ] || fail "macOS icon not found at $ICON_PATH."

node "$ROOT_DIR/build/scripts/package-electron.js" "$ARCH" "$OUT_DIR"

app=$(find "$OUT_DIR" -maxdepth 2 -name 'DevBar.app' -type d | head -n 1)
[ -n "$app" ] || fail "DevBar.app was not generated for $ARCH."

if [ "$(uname -s)" = 'Darwin' ]; then
  readonly APP_ICON="$app/Contents/Resources/icon.icns"
  readonly INFO_PLIST="$app/Contents/Info.plist"

  cp "$ICON_PATH" "$APP_ICON"
  if ! /usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile icon.icns' "$INFO_PLIST"; then
    /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string icon.icns' "$INFO_PLIST"
  fi

  # Ad-hoc re-sign so the code-signing identifier matches CFBundleIdentifier.
  # Electron ships linker-signed as "Electron"; UNUserNotificationCenter matches
  # notifications against that identifier, so a mismatch makes every native
  # notification fail with UNErrorDomain 1 ("not allowed for this application").
  # `--sign -` is ad-hoc: no Apple Developer account, no certificate, no cost.
  # It must run AFTER the plist edits, which invalidate the previous signature.
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")
  [ -n "$bundle_id" ] || fail 'CFBundleIdentifier is missing; cannot sign.'
  codesign --force --deep --sign - --identifier "$bundle_id" "$app" ||
    fail "Ad-hoc signing failed for $ARCH."
  codesign --verify --deep --strict "$app" ||
    fail "Ad-hoc signature did not verify for $ARCH."

  touch "$app"
fi

printf '%s\n' "$app"
