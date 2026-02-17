#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Cleanup handler for temporary files
cleanup() {
	[ -n "$LDD_WRAPPER_DIR" ] && rm -rf "$LDD_WRAPPER_DIR"
}
trap cleanup EXIT

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

# On macOS, if ZIP is requested, also build the .app bundle so it's preserved
if [ "$MAKE_ZIP" = "1" ] && [ "$(uname -s)" = "Darwin" ]; then
	BUNDLE_ARGS="$BUNDLE_ARGS --bundles app"
fi

# Clean old build artifacts
echo "=== Cleaning old build ==="
[ -d "$SCRIPT_DIR/build/release/bundle" ] && rm -rf "$SCRIPT_DIR/build/release/bundle"
[ -d "$SCRIPT_DIR/icons" ] && rm -rf "$SCRIPT_DIR/icons"

# Generate icons from SVG
echo "=== Generating icons ==="
ICONS_DIR="$SCRIPT_DIR/icons"
SVG="$ROOT_DIR/frontend/static/favicon.svg"
mkdir -p "$ICONS_DIR"
CONVERT="convert"
command -v magick >/dev/null 2>&1 && CONVERT="magick"
HAS_RSVG=0
command -v rsvg-convert >/dev/null 2>&1 && HAS_RSVG=1
for SIZE_NAME in "32 32x32" "128 128x128" "256 128x128@2x" "256 icon"; do
	SIZE=$(echo "$SIZE_NAME" | cut -d' ' -f1)
	NAME=$(echo "$SIZE_NAME" | cut -d' ' -f2)
	if [ "$HAS_RSVG" = "1" ]; then
		rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG" | $CONVERT png:- -define png:color-type=6 "$ICONS_DIR/$NAME.png"
	else
		$CONVERT -background none -resize "${SIZE}x${SIZE}" "$SVG" -define png:color-type=6 "$ICONS_DIR/$NAME.png"
	fi
done
if [ "$HAS_RSVG" = "1" ]; then
	rsvg-convert -w 256 -h 256 "$SVG" | $CONVERT png:- "$ICONS_DIR/icon.ico"
else
	$CONVERT -background none -resize "256x256" "$SVG" "$ICONS_DIR/icon.ico"
fi

# Build frontend
echo "=== Building frontend ==="
cd "$ROOT_DIR/frontend"
./build.sh

# Build backend
echo "=== Building backend ==="
cd "$ROOT_DIR/backend"
./build.sh

TARGET=$(rustc --print host-tuple)

# Build Tauri app
echo "=== Building Tauri app ==="
cd "$SCRIPT_DIR"

if [ "$(uname -s)" = "Linux" ]; then
	export APPIMAGE_EXTRACT_AND_RUN=1

	# Wrap ldd to handle Bun standalone binaries that fail ldd analysis.
	# linuxdeploy runs ldd on all ELF files including sidecars; if ldd fails
	# (exit code 1), linuxdeploy crashes. This wrapper returns "statically linked"
	# on failure, telling linuxdeploy to skip dependency deployment for that binary.
	LDD_WRAPPER_DIR=$(mktemp -d)
	cat > "$LDD_WRAPPER_DIR/ldd" << 'LDDWRAPPER'
#!/bin/sh
output=$(/usr/bin/ldd "$@" 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
	echo "	statically linked"
	exit 0
fi
echo "$output"
exit $rc
LDDWRAPPER
	chmod +x "$LDD_WRAPPER_DIR/ldd"
	export PATH="$LDD_WRAPPER_DIR:$PATH"
fi

cargo tauri build $BUNDLE_ARGS

# Move and rename bundles to bundle root (add platform to name)
VERSION=$(grep '"version"' "$SCRIPT_DIR/tauri.conf.json" | head -1 | sed 's/.*: *"//;s/".*//')
ARCH=$(echo "$TARGET" | cut -d'-' -f1)
case "$(uname -s)" in
	Darwin) OS="macos" ;;
	*) OS="linux" ;;
esac
for dir in deb rpm appimage dmg; do
	if [ -d "$SCRIPT_DIR/build/release/bundle/$dir" ]; then
		for f in "$SCRIPT_DIR/build/release/bundle/$dir"/*; do
			[ -f "$f" ] || continue
			EXT="${f##*.}"
			BASENAME=$(basename "$f")
			# Rename to include platform
			case "$EXT" in
				deb)     NEWNAME="LiberShare_${VERSION}_${OS}_${ARCH}.deb" ;;
				rpm)     NEWNAME="LiberShare_${VERSION}_${OS}_${ARCH}.rpm" ;;
				AppImage) NEWNAME="LiberShare_${VERSION}_${OS}_${ARCH}.AppImage" ;;
				dmg)     NEWNAME="LiberShare_${VERSION}_${OS}_${ARCH}.dmg" ;;
				*)       NEWNAME="$BASENAME" ;;
			esac
			mv "$f" "$SCRIPT_DIR/build/release/bundle/$NEWNAME"
		done
		rmdir "$SCRIPT_DIR/build/release/bundle/$dir" 2>/dev/null || true
	fi
done

# Create ZIP bundle if requested
if [ "$MAKE_ZIP" = "1" ]; then
	echo "=== Creating ZIP bundle ==="
	mkdir -p "$SCRIPT_DIR/build/release/bundle"
	case "$(uname -s)" in
		Darwin)
			APP_PATH=$(find "$SCRIPT_DIR/build" -maxdepth 5 -name "LiberShare.app" -type d | head -1)
			if [ -z "$APP_PATH" ]; then
				echo "Error: LiberShare.app not found in build directory"
				exit 1
			fi
			APP_DIR=$(dirname "$APP_PATH")
			cd "$APP_DIR"
			zip -ry "$SCRIPT_DIR/build/release/bundle/LiberShare_${VERSION}_${OS}_${ARCH}.zip" \
				"LiberShare.app"
			;;
		*)
			ZIP_STAGING=$(mktemp -d)
			cp "$SCRIPT_DIR/build/release/libershare" "$ZIP_STAGING/"
			cp "$ROOT_DIR/backend/build/lish-backend" "$ZIP_STAGING/lish-backend"
			chmod +x "$ZIP_STAGING/libershare" "$ZIP_STAGING/lish-backend"
			cd "$ZIP_STAGING"
			zip -ry "$SCRIPT_DIR/build/release/bundle/LiberShare_${VERSION}_${OS}_${ARCH}.zip" .
			rm -rf "$ZIP_STAGING"
			;;
	esac
fi

echo "=== Build complete ==="
echo "Output: $SCRIPT_DIR/build/release/bundle/"
