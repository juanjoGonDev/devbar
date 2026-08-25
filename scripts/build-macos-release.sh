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

  rm -rf "$OUTPUT_DIR" "$WORK_DIR"
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

  rm -rf "$WORK_DIR"
  printf 'macOS release artifacts created in %s\n' "$OUTPUT_DIR"
}

# Sourcing the script exposes the functions without touching the filesystem,
# which is how the retry behaviour is covered by tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
