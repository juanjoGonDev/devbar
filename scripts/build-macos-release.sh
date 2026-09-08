#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly OUTPUT_DIR="$ROOT_DIR/dist/release"
readonly WORK_DIR="$ROOT_DIR/dist/release-work"
readonly VERSION=$(node -p "require('$ROOT_DIR/package.json').version")

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

mach_architecture() {
  case "$1" in
    arm64)
      printf '%s\n' arm64
      ;;
    x64)
      printf '%s\n' x86_64
      ;;
    *)
      fail "Unsupported release architecture: $1"
      ;;
  esac
}

# `hdiutil create` mounts the image while it builds it, and that mount can
# collide with a still-detaching volume of the same name or with Spotlight
# indexing the new one — surfacing as "Resource busy" and failing an otherwise
# healthy release. Detach leftovers, skip the index, and retry a couple of
# times before giving up.
# Overridable so tests can exercise the retry without waiting on it.
DMG_ATTEMPTS=${DMG_ATTEMPTS:-3}
DMG_RETRY_DELAY=${DMG_RETRY_DELAY:-5}

# Mounting a DMG, and writing an .app under dist/, both make Launch Services
# record a bundle at that path. Removing the files does not withdraw the
# record: the entry survives pointing nowhere, and a stale claimant of the
# app's identifier can outrank the real install. macOS resolves things like
# notification permission by identifier, so the wrong claimant is not a
# cosmetic problem — it looks like a permission the user never granted.
# Overridable so tests can exercise this without touching the real database.
LSREGISTER=${LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}

unregister_bundle() {
  local bundle=$1
  [ -x "$LSREGISTER" ] || return 0
  # Idempotent, and happy to withdraw a path that is already gone — which is
  # exactly the case here, since the volume detaches and the work dir is wiped.
  "$LSREGISTER" -u "$bundle" >/dev/null 2>&1 || true
}

# Every bundle the build leaves under a directory, withdrawn before the
# directory goes. Deleting the files first would strand the records.
withdraw_bundles_under() {
  local dir=$1
  [ -d "$dir" ] || return 0
  local bundle
  while IFS= read -r bundle; do
    [ -n "$bundle" ] || continue
    unregister_bundle "$bundle"
  done < <(find "$dir" -maxdepth 4 -name 'DevBar.app' -type d 2>/dev/null)
}

finish_work_dir() {
  withdraw_bundles_under "$WORK_DIR"
  rm -rf "$WORK_DIR"
}

# A build that dies half way must not leak what a finished one cleans up: the
# copies are registered as soon as they exist, and `fail` exits before any
# tidying. Runs on every exit, so the records go whatever the outcome.
release_cleanup() {
  local arch
  for arch in arm64 x64; do
    unregister_bundle "/Volumes/DevBar $VERSION ($arch)/DevBar.app"
  done
  finish_work_dir
}

detach_volume() {
  local volname=$1
  local mount_point="/Volumes/$volname"
  [ -d "$mount_point" ] || return 0
  hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true
}

create_dmg() {
  local arch=$1
  local dmg_root=$2
  local dmg=$3
  local volname="DevBar $VERSION ($arch)"
  local attempt=1

  while :; do
    detach_volume "$volname"
    if hdiutil create \
      -volname "$volname" \
      -srcfolder "$dmg_root" \
      -ov \
      -nospotlight \
      -format UDZO \
      "$dmg"; then
      # hdiutil mounted the volume to fill it; the registration outlives it.
      unregister_bundle "/Volumes/$volname/DevBar.app"
      return 0
    fi
    if [ "$attempt" -ge "$DMG_ATTEMPTS" ]; then
      fail "hdiutil create failed for $arch after $DMG_ATTEMPTS attempts."
    fi
    printf 'warning: hdiutil create failed for %s (attempt %d/%d); retrying in %ds\n' \
      "$arch" "$attempt" "$DMG_ATTEMPTS" "$DMG_RETRY_DELAY" >&2
    attempt=$((attempt + 1))
    sleep "$DMG_RETRY_DELAY"
  done
}

build_architecture() {
  local arch=$1
  local expected_mach_arch
  local package_dir="$WORK_DIR/package-$arch"
  local dmg_root="$WORK_DIR/dmg-$arch"
  local app
  local executable_archs
  local dmg="$OUTPUT_DIR/DevBar-$VERSION-macos-$arch.dmg"
  local zip="$OUTPUT_DIR/DevBar-$VERSION-macos-$arch.zip"

  expected_mach_arch=$(mach_architecture "$arch")
  bash "$ROOT_DIR/scripts/package-macos-app.sh" "$arch" "$package_dir"

  app=$(find "$package_dir" -maxdepth 2 -name 'DevBar.app' -type d | head -n 1)
  [ -n "$app" ] || fail "DevBar.app was not generated for $arch."

  executable_archs=$(lipo -archs "$app/Contents/MacOS/DevBar")
  printf '%s\n' "$executable_archs" | grep -qw "$expected_mach_arch" ||
    fail "Expected $expected_mach_arch executable for $arch, found: $executable_archs"

  [ -s "$app/Contents/Resources/electron.icns" ] || fail "Application icon is missing for $arch."
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$app/Contents/Info.plist")" = 'electron.icns' ] ||
    fail "CFBundleIconFile is incorrect for $arch."

  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

  mkdir -p "$dmg_root"
  ditto "$app" "$dmg_root/DevBar.app"
  ln -s /Applications "$dmg_root/Applications"
  create_dmg "$arch" "$dmg_root" "$dmg"

  [ -s "$zip" ] || fail "ZIP artifact is empty for $arch."
  [ -s "$dmg" ] || fail "DMG artifact is empty for $arch."
}

main() {
  if [ "$(uname -s)" != 'Darwin' ]; then
    fail 'macOS release artifacts must be built on macOS.'
  fi

  if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    fail "package.json version '$VERSION' is not a stable semantic version."
  fi

  # From here on, every copy this build registers is withdrawn on the way out.
  trap release_cleanup EXIT

  rm -rf "$OUTPUT_DIR"
  finish_work_dir # a previous run may have died holding registrations
  mkdir -p "$OUTPUT_DIR" "$WORK_DIR"

  build_architecture arm64
  build_architecture x64

  (
    cd "$OUTPUT_DIR"
    shasum -a 256 \
      "DevBar-$VERSION-macos-arm64.dmg" \
      "DevBar-$VERSION-macos-arm64.zip" \
      "DevBar-$VERSION-macos-x64.dmg" \
      "DevBar-$VERSION-macos-x64.zip" \
      > SHA256SUMS.txt
  )

  finish_work_dir
  printf 'macOS release artifacts created in %s\n' "$OUTPUT_DIR"
}

# Sourcing the script exposes the functions without touching the filesystem,
# which is how the retry behaviour is covered by tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
