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
  # The icon and the ad-hoc signature are both applied by the packager (see
  # scripts/package-electron.ts). Nothing may edit Info.plist from here on:
  # that would invalidate the signature it just applied.
  readonly INFO_PLIST="$app/Contents/Info.plist"

  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")
  [ -n "$bundle_id" ] || fail 'CFBundleIdentifier is missing.'

  signed_id=$(codesign -dv "$app" 2>&1 | sed -n 's/^Identifier=//p')
  [ "$signed_id" = "$bundle_id" ] ||
    fail "Signing identifier is '$signed_id', expected '$bundle_id'."

  # Every nested helper must be signed as ITSELF. A blunt
  # `codesign --deep --identifier <app-id>` stamps the parent's identifier onto
  # all of them, so each helper's signature disagrees with its own
  # CFBundleIdentifier — the exact mismatch this signing step exists to avoid.
  for helper in "$app/Contents/Frameworks/"*.app; do
    [ -d "$helper" ] || continue
    helper_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$helper/Contents/Info.plist")
    helper_signed=$(codesign -dv "$helper" 2>&1 | sed -n 's/^Identifier=//p')
    [ "$helper_signed" = "$helper_id" ] ||
      fail "$(basename "$helper") is signed as '$helper_signed', expected '$helper_id'."
  done

  codesign --verify --deep --strict "$app" ||
    fail "Ad-hoc signature did not verify for $ARCH."

  touch "$app"
fi

printf '%s\n' "$app"
