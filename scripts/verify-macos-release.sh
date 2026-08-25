#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly ROOT_DIR
readonly OUTPUT_DIR=${1:-"$ROOT_DIR/dist/release"}
VERSION=${2:-$(node -p "require('$ROOT_DIR/package.json').version")}
readonly VERSION
MOUNT_POINT=''

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# `hdiutil` reports "Resource temporarily unavailable" on an image the system is
# still settling — the same transient that build-macos-release.sh already
# retries around `hdiutil create`. A DMG written seconds ago is exactly when it
# happens, so verify and attach get the same treatment instead of failing an
# otherwise healthy release.
# Overridable so tests can exercise the retry without waiting on it.
HDIUTIL_ATTEMPTS=${HDIUTIL_ATTEMPTS:-3}
HDIUTIL_RETRY_DELAY=${HDIUTIL_RETRY_DELAY:-3}

hdiutil_retry() {
  local description=$1
  shift
  local attempt=1
  local output
  while :; do
    if output=$("$@" 2>&1); then
      printf '%s' "$output"
      return 0
    fi
    if [ "$attempt" -ge "$HDIUTIL_ATTEMPTS" ]; then
      printf '%s\n' "$output" >&2
      fail "$description failed after $HDIUTIL_ATTEMPTS attempts."
    fi
    printf 'warning: %s failed (attempt %d/%d); retrying in %ds\n' \
      "$description" "$attempt" "$HDIUTIL_ATTEMPTS" "$HDIUTIL_RETRY_DELAY" >&2
    attempt=$((attempt + 1))
    sleep "$HDIUTIL_RETRY_DELAY"
  done
}

cleanup() {
  if [ -n "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

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

  hdiutil_retry "hdiutil verify for $architecture" hdiutil verify "$dmg" >/dev/null
  unzip -tq "$zip" >/dev/null
  zip_entries=$(unzip -Z1 "$zip")
  # here-string, not `printf | grep -q`: under `set -o pipefail`, grep -q closes
  # the pipe on first match and printf dies with SIGPIPE (141), failing the
  # pipeline even though the entry WAS found — a timing-dependent false negative.
  grep -q '^DevBar\.app/Contents/MacOS/DevBar$' <<<"$zip_entries" ||
    fail "ZIP does not contain the DevBar executable for $architecture."

  mount_output=$(hdiutil_retry "hdiutil attach for $architecture" hdiutil attach "$dmg" -nobrowse -readonly)
  MOUNT_POINT=$(printf '%s\n' "$mount_output" | awk -F '\t' '$3 ~ /^\/Volumes\// { print $3; exit }')
  [ -n "$MOUNT_POINT" ] || fail "Unable to resolve the mounted DMG path for $architecture."

  [ -d "$MOUNT_POINT/DevBar.app" ] || fail "DMG does not contain DevBar.app for $architecture."
  [ -L "$MOUNT_POINT/Applications" ] || fail "DMG does not contain the Applications link for $architecture."
  [ "$(readlink "$MOUNT_POINT/Applications")" = '/Applications' ] ||
    fail "DMG Applications link is incorrect for $architecture."

  executable_archs=$(lipo -archs "$MOUNT_POINT/DevBar.app/Contents/MacOS/DevBar")
  grep -qw "$expected_mach_arch" <<<"$executable_archs" ||
    fail "Expected $expected_mach_arch executable for $architecture, found: $executable_archs"

  [ -s "$MOUNT_POINT/DevBar.app/Contents/Resources/electron.icns" ] ||
    fail "Application icon is missing for $architecture."
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$MOUNT_POINT/DevBar.app/Contents/Info.plist")" = 'electron.icns' ] ||
    fail "CFBundleIconFile is incorrect for $architecture."
  plutil -lint "$MOUNT_POINT/DevBar.app/Contents/Info.plist" >/dev/null

  hdiutil detach "$MOUNT_POINT" >/dev/null
  MOUNT_POINT=''

  printf 'Verified macOS %s installer (%s).\n' "$architecture" "$expected_mach_arch"
}

main() {
  if [ "$(uname -s)" != 'Darwin' ]; then
    fail 'macOS release artifacts must be verified on macOS.'
  fi

  node "$ROOT_DIR/build/scripts/verify-release-artifacts.js" "$OUTPUT_DIR" "$VERSION"

  verify_architecture arm64
  verify_architecture x64

  printf 'macOS release validation completed for DevBar v%s.\n' "$VERSION"
}

# Sourcing the script exposes the functions without verifying anything, which
# is how the hdiutil retry is covered by tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
