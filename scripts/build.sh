#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
rm -rf build
./node_modules/.bin/tsc -p tsconfig.node.json
./node_modules/.bin/tsc -p tsconfig.renderer.json
./node_modules/.bin/esbuild src/preload.ts --bundle --platform=node --format=cjs --target=node22 --external:electron --outfile=build/src/preload.cjs
mkdir -p build/renderer build/assets
cp renderer/*.html renderer/*.css build/renderer/
cp -R assets/. build/assets/
