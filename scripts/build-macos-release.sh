#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly OUTPUT_DIR="$ROOT_DIR/dist/release"
readonly WORK_DIR="$ROOT_DIR/dist/release-work"
readonly VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
readonly ICON_PATH="$ROOT_DIR/assets/icon.icns"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

if [ "$(uname -s)" != 'Darwin' ]; then
  fail 'macOS release artifacts must be built on macOS.'
fi

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  fail "package.json version '$VERSION' is not a stable semantic version."
fi

[ -s "$ICON_PATH" ] || fail "macOS icon not found at $ICON_PATH."

rm -rf "$OUTPUT_DIR" "$WORK_DIR"
mkdir -p "$OUTPUT_DIR" "$WORK_DIR"

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

  pnpm exec electron-packager . DevBar \
    --platform=darwin \
    --arch="$arch" \
    --out="$package_dir" \
    --overwrite \
    --icon="$ICON_PATH" \
    --ignore='^/dist($|/)' \
    --ignore='^/tests($|/)' \
    --ignore='^/\.agents($|/)' \
    --ignore='^/\.github($|/)'

  app=$(find "$package_dir" -maxdepth 2 -name 'DevBar.app' -type d | head -n 1)
  [ -n "$app" ] || fail "DevBar.app was not generated for $arch."

  executable_archs=$(lipo -archs "$app/Contents/MacOS/DevBar")
  printf '%s\n' "$executable_archs" | grep -qw "$expected_mach_arch" ||
    fail "Expected $expected_mach_arch executable for $arch, found: $executable_archs"

  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

  mkdir -p "$dmg_root"
  ditto "$app" "$dmg_root/DevBar.app"
  ln -s /Applications "$dmg_root/Applications"
  hdiutil create \
    -volname "DevBar $VERSION ($arch)" \
    -srcfolder "$dmg_root" \
    -ov \
    -format UDZO \
    "$dmg"

  [ -s "$zip" ] || fail "ZIP artifact is empty for $arch."
  [ -s "$dmg" ] || fail "DMG artifact is empty for $arch."
}

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
