#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly OUTPUT_DIR=${1:-"$ROOT_DIR/dist/release"}
readonly VERSION=${2:-$(node -p "require('$ROOT_DIR/package.json').version")}
MOUNT_POINT=''

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

if [ "$(uname -s)" != 'Darwin' ]; then
  fail 'macOS release artifacts must be verified on macOS.'
fi

node "$ROOT_DIR/scripts/verify-release-artifacts.js" "$OUTPUT_DIR" "$VERSION"

verify_architecture() {
  local architecture=$1
  local expected_mach_arch
  local dmg="$OUTPUT_DIR/DevBar-$VERSION-macos-$architecture.dmg"
  local zip="$OUTPUT_DIR/DevBar-$VERSION-macos-$architecture.zip"
  local mount_output
  local executable_archs
  local zip_entries

  case "$architecture" in
    arm64) expected_mach_arch=arm64 ;;
    x64) expected_mach_arch=x86_64 ;;
    *) fail "Unsupported release architecture: $architecture" ;;
  esac

  hdiutil verify "$dmg" >/dev/null
  unzip -tq "$zip" >/dev/null
  zip_entries=$(unzip -Z1 "$zip")
  printf '%s\n' "$zip_entries" | grep -q '^DevBar\.app/Contents/MacOS/DevBar$' ||
    fail "ZIP does not contain the DevBar executable for $architecture."

  mount_output=$(hdiutil attach "$dmg" -nobrowse -readonly)
  MOUNT_POINT=$(printf '%s\n' "$mount_output" | awk -F '\t' '$3 ~ /^\/Volumes\// { print $3; exit }')
  [ -n "$MOUNT_POINT" ] || fail "Unable to resolve the mounted DMG path for $architecture."

  [ -d "$MOUNT_POINT/DevBar.app" ] || fail "DMG does not contain DevBar.app for $architecture."
  [ -L "$MOUNT_POINT/Applications" ] || fail "DMG does not contain the Applications link for $architecture."
  [ "$(readlink "$MOUNT_POINT/Applications")" = '/Applications' ] ||
    fail "DMG Applications link is incorrect for $architecture."

  executable_archs=$(lipo -archs "$MOUNT_POINT/DevBar.app/Contents/MacOS/DevBar")
  printf '%s\n' "$executable_archs" | grep -qw "$expected_mach_arch" ||
    fail "Expected $expected_mach_arch executable for $architecture, found: $executable_archs"

  [ -s "$MOUNT_POINT/DevBar.app/Contents/Resources/icon.icns" ] ||
    fail "Application icon is missing for $architecture."
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$MOUNT_POINT/DevBar.app/Contents/Info.plist")" = 'icon.icns' ] ||
    fail "CFBundleIconFile is incorrect for $architecture."
  plutil -lint "$MOUNT_POINT/DevBar.app/Contents/Info.plist" >/dev/null

  hdiutil detach "$MOUNT_POINT" >/dev/null
  MOUNT_POINT=''

  printf 'Verified macOS %s installer (%s).\n' "$architecture" "$expected_mach_arch"
}

verify_architecture arm64
verify_architecture x64

printf 'macOS release validation completed for DevBar v%s.\n' "$VERSION"
