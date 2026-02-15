#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arguments
BUNDLE_ARGS=""
for arg in "$@"; do
	case "$arg" in
		--deb) BUNDLE_ARGS="$BUNDLE_ARGS --bundles deb" ;;
		--rpm) BUNDLE_ARGS="$BUNDLE_ARGS --bundles rpm" ;;
		--dmg) BUNDLE_ARGS="$BUNDLE_ARGS --bundles dmg" ;;
		*) echo "Unknown argument: $arg"; echo "Usage: ./build.sh [--deb] [--rpm] [--dmg]"; exit 1 ;;
	esac
done

# Clean old build artifacts
echo "=== Cleaning old build ==="
[ -d "$SCRIPT_DIR/build/release/bundle" ] && rm -rf "$SCRIPT_DIR/build/release/bundle"
[ -d "$SCRIPT_DIR/binaries" ] && rm -rf "$SCRIPT_DIR/binaries"
[ -d "$SCRIPT_DIR/icons" ] && rm -rf "$SCRIPT_DIR/icons"

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
cargo tauri build $BUNDLE_ARGS

echo "=== Build complete ==="
if [ -n "$BUNDLE_ARGS" ]; then
	echo "Output: $SCRIPT_DIR/build/release/bundle/"
else
	echo "Output: $SCRIPT_DIR/build/release/libershare"
	echo "To create packages, run: ./build.sh --deb and/or ./build.sh --rpm"
fi
