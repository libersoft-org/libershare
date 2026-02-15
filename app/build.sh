#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Generate icons from SVG
echo "=== Generating icons ==="
ICONS_DIR="$SCRIPT_DIR/icons"
SVG="$ROOT_DIR/frontend/static/favicon.svg"
mkdir -p "$ICONS_DIR"
for SIZE_NAME in "32 32x32" "128 128x128" "256 128x128@2x" "256 icon"; do
	SIZE=$(echo "$SIZE_NAME" | cut -d' ' -f1)
	NAME=$(echo "$SIZE_NAME" | cut -d' ' -f2)
	rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG" | convert png:- -define png:color-type=6 "$ICONS_DIR/$NAME.png"
done
rsvg-convert -w 256 -h 256 "$SVG" | convert png:- "$ICONS_DIR/icon.ico"

# Build frontend
echo "=== Building frontend ==="
cd "$ROOT_DIR/frontend"
./build.sh

# Build backend
echo "=== Building backend ==="
cd "$ROOT_DIR/backend"
./build.sh

# Copy backend binary with target triple
echo "=== Preparing sidecar ==="
TARGET=$(rustc --print host-tuple)
BINARIES_DIR="$SCRIPT_DIR/binaries"
mkdir -p "$BINARIES_DIR"
cp "$ROOT_DIR/backend/build/lish-backend" "$BINARIES_DIR/lish-backend-$TARGET"
echo "Copied lish-backend as lish-backend-$TARGET"

# Build Tauri app
echo "=== Building Tauri app ==="
cd "$SCRIPT_DIR"
cargo tauri build

echo "=== Build complete ==="
echo "Output: $SCRIPT_DIR/build/release/bundle/"
