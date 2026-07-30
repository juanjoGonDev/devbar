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

node "$ROOT_DIR/scripts/package-electron.js" "$ARCH" "$OUT_DIR"

app=$(find "$OUT_DIR" -maxdepth 2 -name 'DevBar.app' -type d | head -n 1)
[ -n "$app" ] || fail "DevBar.app was not generated for $ARCH."

if [ "$(uname -s)" = 'Darwin' ]; then
  readonly APP_ICON="$app/Contents/Resources/icon.icns"
  readonly INFO_PLIST="$app/Contents/Info.plist"

  cp "$ICON_PATH" "$APP_ICON"
  if ! /usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile icon.icns' "$INFO_PLIST"; then
    /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string icon.icns' "$INFO_PLIST"
  fi
  touch "$app"
fi

printf '%s\n' "$app"
