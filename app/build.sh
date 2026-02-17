#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arguments
BUNDLE_ARGS=""
MAKE_ZIP=0
for arg in "$@"; do
	case "$arg" in
		--deb) BUNDLE_ARGS="$BUNDLE_ARGS --bundles deb" ;;
		--rpm) BUNDLE_ARGS="$BUNDLE_ARGS --bundles rpm" ;;
		--appimage) BUNDLE_ARGS="$BUNDLE_ARGS --bundles appimage" ;;
		--dmg) BUNDLE_ARGS="$BUNDLE_ARGS --bundles dmg" ;;
		--zip) MAKE_ZIP=1 ;;
		*) echo "Unknown argument: $arg"; echo "Usage: ./build.sh [--deb] [--rpm] [--appimage] [--dmg] [--zip]"; exit 1 ;;
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
CONVERT="convert"
command -v magick >/dev/null 2>&1 && CONVERT="magick"
for SIZE_NAME in "32 32x32" "128 128x128" "256 128x128@2x" "256 icon"; do
	SIZE=$(echo "$SIZE_NAME" | cut -d' ' -f1)
	NAME=$(echo "$SIZE_NAME" | cut -d' ' -f2)
	rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG" | $CONVERT png:- -define png:color-type=6 "$ICONS_DIR/$NAME.png"
done
rsvg-convert -w 256 -h 256 "$SVG" | $CONVERT png:- "$ICONS_DIR/icon.ico"

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

# Move bundles to bundle root
for dir in deb rpm appimage dmg; do
	if [ -d "$SCRIPT_DIR/build/release/bundle/$dir" ]; then
		mv "$SCRIPT_DIR/build/release/bundle/$dir"/* "$SCRIPT_DIR/build/release/bundle/" 2>/dev/null || true
		rmdir "$SCRIPT_DIR/build/release/bundle/$dir" 2>/dev/null || true
	fi
done

# Create ZIP bundle if requested
if [ "$MAKE_ZIP" = "1" ]; then
	echo "=== Creating ZIP bundle ==="
	VERSION=$(grep '"version"' "$SCRIPT_DIR/tauri.conf.json" | head -1 | sed 's/.*: *"//;s/".*//')
	ARCH=$(uname -m)
	case "$(uname -s)" in
		Darwin)
			APP_PATH=$(find "$SCRIPT_DIR/build" -name "LiberShare.app" -type d -maxdepth 5 | head -1)
			if [ -z "$APP_PATH" ]; then
				echo "Error: LiberShare.app not found in build directory"
				exit 1
			fi
			APP_DIR=$(dirname "$APP_PATH")
			cd "$APP_DIR"
			zip -ry "$SCRIPT_DIR/build/release/bundle/LiberShare_${VERSION}_${ARCH}.zip" \
				"LiberShare.app"
			;;
		*)
			cd "$SCRIPT_DIR/build/release"
			zip -j "$SCRIPT_DIR/build/release/bundle/LiberShare_${VERSION}_${ARCH}.zip" \
				"$SCRIPT_DIR/build/release/libershare" \
				"$BINARIES_DIR/lish-backend-$TARGET"
			;;
	esac
fi

echo "=== Build complete ==="
echo "Output: $SCRIPT_DIR/build/release/bundle/"
